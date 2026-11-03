import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { can, canServeDepartment } from "../../auth/permissions.ts";
import { localDate } from "../../common/time.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { getEncounter, getInvoice, issueInvoice } from "../billing/service.ts";
import { getActs, requirePayer } from "../catalog/service.ts";
import { patientSummaries, requireActivePatient } from "../identity/interface.ts";
import { consumeForAct } from "../stock/service.ts";
import {
  completeTicketIn,
  getOrder,
  placeOrderIn,
  startTicketIn,
  ticketsOf,
} from "../orders/service.ts";

/** Acte de la nuitée au catalogue (code d'exemple de l'import du catalogue ; à confirmer, question Q24). */
export const NIGHT_ACT = "HOSP-1J";

const person = (ctx: RequestContext) => ({ userId: ctx.user.id, name: ctx.user.name });

/** Nombre de jours entre deux dates AAAA-MM-JJ. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Nuitées passées à une date de sortie : la première est dans le forfait payé d'avance ; une nuit de plus par jour
 * calendaire écoulé. Une sortie le jour même de l'entrée compte une nuit (le forfait).
 */
export function nightsSpent(admittedDate: string, exitDate: string): number {
  return Math.max(1, daysBetween(admittedDate, exitDate));
}

interface StayRow {
  id: string;
  number: string;
  patient_id: string;
  encounter_id: string;
  status: "awaiting_payment" | "admitted" | "discharge_pending" | "discharged" | "cancelled";
  initial_order_id: string;
  initial_order_number: string;
  requested_by: string;
  created_at: Date;
  bed_code: string | null;
  admitted_at: Date | null;
  nights: number | null;
  final_invoice_id: string | null;
  exited_at: Date | null;
  exit_unpaid_reason: string | null;
  discharge_ordered_at: Date | null;
}
const COLS = `id, number, patient_id, encounter_id, status, initial_order_id, initial_order_number, requested_by, created_at,
  bed_code, admitted_at, nights, final_invoice_id, exited_at, exit_unpaid_reason, discharge_ordered_at`;

const toStay = (r: StayRow) => ({
  id: r.id,
  number: r.number,
  patientId: r.patient_id,
  encounterId: r.encounter_id,
  status: r.status,
  initialOrderId: r.initial_order_id,
  initialOrderNumber: r.initial_order_number,
  requestedBy: r.requested_by,
  createdAt: r.created_at.toISOString(),
  bedCode: r.bed_code,
  admittedAt: r.admitted_at?.toISOString() ?? null,
  nights: r.nights,
  finalInvoiceId: r.final_invoice_id,
  dischargeOrderedAt: r.discharge_ordered_at?.toISOString() ?? null,
  exitedAt: r.exited_at?.toISOString() ?? null,
  exitUnpaidReason: r.exit_unpaid_reason,
});
export type Stay = ReturnType<typeof toStay>;

async function lockStay(tx: Tx, id: string): Promise<StayRow> {
  const res = await tx.query<StayRow>(`select ${COLS} from hosp.stays where id = $1 for update`, [
    id,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound("Séjour");
  return row;
}

/* ------------------------------------------------------------------ lits */

export async function listBeds(db: Db) {
  const res = await db.query<{
    code: string;
    ward: string;
    label: string;
    active: boolean;
    stay_id: string | null;
    number: string | null;
    patient_id: string | null;
  }>(
    `select b.code, b.ward, b.label, b.active, s.id as stay_id, s.number, s.patient_id
       from hosp.beds b left join hosp.stays s on s.bed_code = b.code and s.status in ('admitted', 'discharge_pending')
      order by b.ward, b.code`,
  );
  const people = await patientSummaries(
    db,
    res.rows.flatMap((r) => (r.patient_id ? [r.patient_id] : [])),
  );
  return res.rows.map((r) => ({
    code: r.code,
    ward: r.ward,
    label: r.label,
    active: r.active,
    occupied: r.stay_id !== null,
    stay: r.stay_id
      ? { id: r.stay_id, number: r.number, patient: people.get(r.patient_id as string) ?? null }
      : null,
  }));
}

export async function createBed(
  db: Db,
  ctx: RequestContext,
  input: { code: string; ward: string; label: string },
) {
  return withTransaction(db, async (tx) => {
    const dup = await tx.query("select 1 from hosp.beds where code = $1", [input.code]);
    if (dup.rowCount) throw new DomainError("bed_exists", "Ce lit existe déjà.", 409);
    await tx.query("insert into hosp.beds (code, ward, label) values ($1, $2, $3)", [
      input.code,
      input.ward,
      input.label,
    ]);
    await writeAudit(tx, ctx, {
      action: "hosp.bed.create",
      entityType: "bed",
      entityId: input.code,
    });
    return { ...input, active: true };
  });
}

/* ------------------------------------------------------------------ séjour : forfait initial */

export interface CreateStayInput {
  patientId: string;
  encounterId: string;
  /** Forfait initial : la nuitée (une seule) et l'acte initial éventuel. */
  items: { actCode: string; quantity: number }[];
  note?: string | undefined;
}

/**
 * Le médecin décide l'hospitalisation. Le forfait initial (première nuit et acte initial) est une demande payée
 * à la caisse d'abord, avec ou sans remise : l'entrée au lit n'est possible qu'ensuite (règle de la caisse).
 */
export async function createStay(db: Db, ctx: RequestContext, input: CreateStayInput) {
  return withTransaction(db, async (tx) => {
    const night = input.items.filter((i) => i.actCode === NIGHT_ACT);
    if (night.length !== 1 || night[0]?.quantity !== 1)
      throw new DomainError(
        "first_night_required",
        `Le forfait initial comprend exactement une nuitée (acte ${NIGHT_ACT}) : les nuits suivantes se facturent à la sortie.`,
        400,
      );
    const patient = await requireActivePatient(tx, input.patientId);
    const open = await tx.query(
      "select 1 from hosp.stays where patient_id = $1 and status in ('awaiting_payment', 'admitted', 'discharge_pending')",
      [patient.id],
    );
    if (open.rowCount)
      throw new DomainError("stay_already_open", "Ce patient a déjà un séjour en cours.", 409);
    const order = await placeOrderIn(tx, ctx, {
      patientId: patient.id,
      encounterId: input.encounterId,
      items: input.items,
      ...(input.note ? { note: input.note } : {}),
    });
    const number = await nextNumber(tx, "hosp", "stay", "H");
    const created = await tx.query<StayRow>(
      `insert into hosp.stays (number, patient_id, encounter_id, initial_order_id, initial_order_number, requested_by, requested_by_name)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS}`,
      [number, patient.id, input.encounterId, order.id, order.number, ctx.user.id, ctx.user.name],
    );
    const stay = created.rows[0] as StayRow;
    await tx.query(
      "insert into hosp.stay_orders (stay_id, order_id, order_number, kind, placed_by) values ($1, $2, $3, 'initial', $4)",
      [stay.id, order.id, order.number, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "stay.create",
      entityType: "stay",
      entityId: stay.id,
      patientId: patient.id,
      detail: { number, orderNumber: order.number },
    });
    return { ...toStay(stay), order };
  });
}

/** Entrée au lit : possible seulement quand la caisse a validé le forfait initial et que le ticket est libéré. */
export async function admitToBed(db: Db, ctx: RequestContext, stayId: string, bedCode: string) {
  return withTransaction(db, async (tx) => {
    const stay = await lockStay(tx, stayId);
    if (stay.status !== "awaiting_payment")
      throw new DomainError(
        "not_awaiting_admission",
        "Ce séjour n'attend pas d'entrée au lit.",
        409,
      );
    const order = await getOrder(tx as unknown as Db, stay.initial_order_id);
    if (order.status === "awaiting_payment" || order.status === "cancelled")
      throw new DomainError(
        "payment_required",
        "Le forfait initial n'est pas encore payé à la caisse : entrée impossible.",
        409,
      );
    const ticket = (await ticketsOf(tx, stay.initial_order_id)).find(
      (t) => t.departmentCode === "HOSP",
    );
    if (!ticket)
      throw new DomainError(
        "ticket_required",
        "Aucun ticket d'hospitalisation libéré par la caisse.",
        409,
      );
    const bed = await tx.query<{ active: boolean }>(
      "select active from hosp.beds where code = $1",
      [bedCode],
    );
    if (!bed.rows[0]?.active) throw new DomainError("unknown_bed", "Lit inconnu ou inactif.", 400);
    const taken = await tx.query(
      "select 1 from hosp.stays where bed_code = $1 and status in ('admitted', 'discharge_pending')",
      [bedCode],
    );
    if (taken.rowCount) throw new DomainError("bed_occupied", "Ce lit est déjà occupé.", 409);
    if (ticket.status === "sent") await startTicketIn(tx, ctx, ticket.id);
    await tx.query(
      "update hosp.stays set status = 'admitted', bed_code = $2, admitted_at = now(), admitted_by = $3 where id = $1",
      [stayId, bedCode, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "stay.admit",
      entityType: "stay",
      entityId: stayId,
      patientId: stay.patient_id,
      detail: { number: stay.number, bed: bedCode, ticket: ticket.code },
    });
    await appendEvent(tx, ctx, {
      type: "StayAdmitted",
      patientId: stay.patient_id,
      payload: {
        stayId,
        stayNumber: stay.number,
        bedCode,
        initialOrderId: stay.initial_order_id,
        admittedBy: person(ctx),
      },
    });
    return toStay(await lockStay(tx, stayId));
  });
}

/* ------------------------------------------------------------------ pendant le séjour */

/** Acte lourd en cours de séjour : demande à part, payée à la caisse avant exécution (comme une radio). */
export async function placeExtraOrder(
  db: Db,
  ctx: RequestContext,
  stayId: string,
  input: { items: { actCode: string; quantity: number }[]; note?: string | undefined },
) {
  return withTransaction(db, async (tx) => {
    const stay = await lockStay(tx, stayId);
    if (stay.status !== "admitted")
      throw new DomainError(
        "stay_not_admitted",
        "Les demandes se font pendant le séjour, avant l'ordre de sortie.",
        409,
      );
    if (input.items.some((i) => i.actCode === NIGHT_ACT))
      throw new DomainError(
        "nights_accrue",
        "Les nuitées ne se demandent pas : elles se facturent à la sortie.",
        400,
      );
    const order = await placeOrderIn(tx, ctx, {
      patientId: stay.patient_id,
      encounterId: stay.encounter_id,
      items: input.items,
      ...(input.note ? { note: input.note } : {}),
    });
    await tx.query(
      "insert into hosp.stay_orders (stay_id, order_id, order_number, kind, placed_by) values ($1, $2, $3, 'extra', $4)",
      [stayId, order.id, order.number, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "stay.order",
      entityType: "stay",
      entityId: stayId,
      patientId: stay.patient_id,
      detail: { number: stay.number, orderNumber: order.number },
    });
    return order;
  });
}

/**
 * Soins courants et consommables ajoutés au séjour, facturés à la sortie. Seuls les actes d'hospitalisation du catalogue
 * s'ajoutent ainsi ; tout autre acte (opération, radio, analyse) doit être demandé et payé à la caisse d'abord.
 */
export async function addCharge(
  db: Db,
  ctx: RequestContext,
  stayId: string,
  input: { actCode: string; quantity: number; note?: string | undefined },
) {
  return withTransaction(db, async (tx) => {
    const stay = await lockStay(tx, stayId);
    if (stay.status !== "admitted")
      throw new DomainError(
        "stay_not_admitted",
        "Les soins s'ajoutent pendant le séjour, avant l'ordre de sortie.",
        409,
      );
    if (input.actCode === NIGHT_ACT)
      throw new DomainError(
        "nights_accrue",
        "Les nuitées sont calculées à la sortie : ne les ajoutez pas à la main.",
        400,
      );
    const act = (await getActs(tx, [input.actCode])).get(input.actCode);
    if (!act) throw notFound(`Acte ${input.actCode}`);
    if (!act.active)
      throw new DomainError("act_inactive", `L'acte ${input.actCode} n'est plus proposé.`, 409);
    if (act.category !== "hospitalization")
      throw new DomainError(
        "must_be_ordered",
        "Cet acte se règle à la caisse avant son exécution : faites une demande de prestation pour ce séjour.",
        409,
      );
    const res = await tx.query<{ id: string }>(
      `insert into hosp.charges (stay_id, kind, act_code, quantity, unit_price, note, added_by, added_by_name)
       values ($1, 'care', $2, $3, $4, $5, $6, $7) returning id`,
      [
        stayId,
        act.code,
        input.quantity,
        act.tariff,
        input.note ?? null,
        ctx.user.id,
        ctx.user.name,
      ],
    );
    // Les soins courants consomment leur recette (seringues, compresses...) dans le dépôt d'hospitalisation.
    await consumeForAct(tx, ctx, {
      actCode: act.code,
      times: input.quantity,
      department: "HOSP",
      patientId: stay.patient_id,
      refType: "stay",
      refId: stay.number,
    });
    await writeAudit(tx, ctx, {
      action: "stay.charge",
      entityType: "stay",
      entityId: stayId,
      patientId: stay.patient_id,
      detail: { act: act.code, quantity: input.quantity, unitPrice: act.tariff },
    });
    return {
      id: Number(res.rows[0]?.id),
      actCode: act.code,
      quantity: input.quantity,
      unitPrice: act.tariff,
    };
  });
}

/* ------------------------------------------------------------------ lecture */

export async function getStay(db: Db, ctx: RequestContext, stayId: string) {
  const res = await db.query<StayRow>(`select ${COLS} from hosp.stays where id = $1`, [stayId]);
  const row = res.rows[0];
  if (!row) throw notFound("Séjour");
  const stay = toStay(row);
  const people = await patientSummaries(db, [row.patient_id]);
  const orders = await db.query<{ order_id: string; order_number: string; kind: string }>(
    "select order_id, order_number, kind from hosp.stay_orders where stay_id = $1 order by id",
    [stayId],
  );
  const orderViews = [];
  for (const o of orders.rows) {
    const order = await getOrder(db, o.order_id);
    orderViews.push({ id: o.order_id, number: o.order_number, kind: o.kind, status: order.status });
  }
  const charges = await db.query<{
    id: string;
    kind: string;
    night_date: string | null;
    act_code: string;
    quantity: number;
    unit_price: number;
    note: string | null;
    invoice_id: string | null;
  }>(
    "select id, kind, night_date::text as night_date, act_code, quantity, unit_price, note, invoice_id from hosp.charges where stay_id = $1 order by id",
    [stayId],
  );
  // Solde prévisionnel : nuitées accumulées à ce jour et soins non encore facturés (rien n'est écrit tant que la sortie n'est pas ordonnée).
  let projected: {
    nights: number;
    extraNights: number;
    extraNightsAmount: number;
    careAmount: number;
    total: number;
  } | null = null;
  if (row.status === "admitted" && row.admitted_at) {
    const nights = nightsSpent(localDate(row.admitted_at), localDate(new Date()));
    const act = (await getActs(db, [NIGHT_ACT])).get(NIGHT_ACT);
    const extraNights = nights - 1;
    const extraNightsAmount = extraNights * (act?.tariff ?? 0);
    const careAmount = charges.rows
      .filter((c) => c.kind === "care" && !c.invoice_id)
      .reduce((n, c) => n + c.quantity * c.unit_price, 0);
    projected = {
      nights,
      extraNights,
      extraNightsAmount,
      careAmount,
      total: extraNightsAmount + careAmount,
    };
  }
  const invoice = row.final_invoice_id ? await getInvoice(db, row.final_invoice_id) : null;
  await writeAudit(db as unknown as Tx, ctx, {
    action: "stay.read",
    entityType: "stay",
    entityId: stayId,
    patientId: row.patient_id,
  });
  return {
    ...stay,
    patient: people.get(row.patient_id) ?? null,
    orders: orderViews,
    charges: charges.rows.map((c) => ({
      id: Number(c.id),
      kind: c.kind,
      nightDate: c.night_date,
      actCode: c.act_code,
      quantity: c.quantity,
      unitPrice: c.unit_price,
      note: c.note,
      invoiced: c.invoice_id !== null,
    })),
    projected,
    finalInvoice: invoice
      ? {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          total: invoice.total,
          patientAmount: invoice.patientAmount,
          amountDue: invoice.amountDue,
          discount: invoice.discount,
        }
      : null,
  };
}

export async function listStays(db: Db, status?: string) {
  const res = await db.query<StayRow>(
    `select ${COLS} from hosp.stays where ($1::text is null or status = $1) order by created_at desc limit 200`,
    [status ?? null],
  );
  const people = await patientSummaries(
    db,
    res.rows.map((r) => r.patient_id),
  );
  return res.rows.map((r) => ({ ...toStay(r), patient: people.get(r.patient_id) ?? null }));
}

/* ------------------------------------------------------------------ sortie */

/**
 * Ordre de sortie du médecin : les nuitées accumulées et les soins courants forment la facture de sortie, émise à la caisse.
 * Les demandes d'actes encore impayées bloquent la sortie : elles se règlent ou s'annulent d'abord.
 */
export async function orderDischarge(db: Db, ctx: RequestContext, stayId: string) {
  return withTransaction(db, async (tx) => {
    const stay = await lockStay(tx, stayId);
    if (stay.status !== "admitted" || !stay.admitted_at)
      throw new DomainError("stay_not_admitted", "Seul un patient hospitalisé peut sortir.", 409);
    const unpaid = await tx.query<{ order_number: string }>(
      `select so.order_number from hosp.stay_orders so join orders.service_orders o on o.id = so.order_id
        where so.stay_id = $1 and o.status = 'awaiting_payment'`,
      [stayId],
    );
    if (unpaid.rowCount)
      throw new DomainError(
        "orders_unpaid",
        "Des demandes de prestations de ce séjour n'ont pas été payées à la caisse : réglez-les ou annulez-les avant la sortie.",
        409,
        {
          orders: unpaid.rows.map((r) => r.order_number),
        },
      );
    const today = localDate(new Date());
    const admittedDate = localDate(stay.admitted_at);
    const nights = nightsSpent(admittedDate, today);
    // Nuits à facturer : toutes sauf la première (déjà dans le forfait payé).
    const nightAct = (await getActs(tx, [NIGHT_ACT])).get(NIGHT_ACT);
    if (!nightAct)
      throw new DomainError(
        "night_act_missing",
        `L'acte de nuitée ${NIGHT_ACT} est absent du catalogue.`,
        409,
      );
    for (let k = 1; k < nights; k += 1) {
      await tx.query(
        `insert into hosp.charges (stay_id, kind, night_date, act_code, quantity, unit_price, added_by, added_by_name)
         values ($1, 'night', $2, $3, 1, $4, $5, $6) on conflict do nothing`,
        [stayId, addDays(admittedDate, k), NIGHT_ACT, nightAct.tariff, ctx.user.id, ctx.user.name],
      );
    }
    const due = await tx.query<{
      id: string;
      act_code: string;
      quantity: number;
      unit_price: number;
    }>(
      "select id, act_code, quantity, unit_price from hosp.charges where stay_id = $1 and invoice_id is null order by id for update",
      [stayId],
    );
    let invoiceId: string | null = null;
    if (due.rows.length > 0) {
      // Lignes regroupées par acte et prix : les nuits ensemble, chaque soin avec son prix du jour.
      const grouped = new Map<string, { actCode: string; unitPrice: number; quantity: number }>();
      for (const c of due.rows) {
        const key = `${c.act_code}|${c.unit_price}`;
        const g = grouped.get(key) ?? { actCode: c.act_code, unitPrice: c.unit_price, quantity: 0 };
        g.quantity += c.quantity;
        grouped.set(key, g);
      }
      const acts = await getActs(tx, [...new Set([...grouped.values()].map((g) => g.actCode))]);
      const encounter = await getEncounter(tx, stay.encounter_id);
      const payer = await requirePayer(tx, encounter.payerCode);
      const invoice = await issueInvoice(tx, ctx, {
        encounterId: stay.encounter_id,
        orderId: null,
        orderNumber: stay.number,
        patientId: stay.patient_id,
        payer,
        lines: [...grouped.values()].map((g) => ({
          act: acts.get(g.actCode) as NonNullable<ReturnType<typeof acts.get>>,
          unitPrice: g.unitPrice,
          quantity: g.quantity,
        })),
      });
      invoiceId = invoice.id;
      await tx.query("update hosp.charges set invoice_id = $2 where id = any($1::bigint[])", [
        due.rows.map((c) => c.id),
        invoiceId,
      ]);
    }
    await tx.query(
      "update hosp.stays set status = 'discharge_pending', discharge_ordered_at = now(), discharge_ordered_by = $2, nights = $3, final_invoice_id = $4 where id = $1",
      [stayId, ctx.user.id, nights, invoiceId],
    );
    await writeAudit(tx, ctx, {
      action: "stay.discharge-order",
      entityType: "stay",
      entityId: stayId,
      patientId: stay.patient_id,
      detail: { number: stay.number, nights, invoiceId },
    });
    return toStay(await lockStay(tx, stayId));
  });
}

/**
 * Sortie effective du patient : la facture de sortie doit être payée à la caisse. La direction peut autoriser une sortie
 * avec facture impayée, avec motif écrit, tracé et publié dans l'événement.
 */
export async function exitStay(db: Db, ctx: RequestContext, stayId: string, unpaidReason?: string) {
  return withTransaction(db, async (tx) => {
    const stay = await lockStay(tx, stayId);
    if (stay.status !== "discharge_pending")
      throw new DomainError(
        "discharge_not_ordered",
        "Le médecin n'a pas encore ordonné la sortie.",
        409,
      );
    let exitedUnpaid = false;
    if (stay.final_invoice_id) {
      const inv = await getInvoice(tx as unknown as Db, stay.final_invoice_id);
      if (inv.status !== "paid") {
        if (!can(ctx.user.roles, "stay:exit-unpaid"))
          throw new DomainError(
            "final_invoice_unpaid",
            `La facture de sortie ${inv.number} (${inv.amountDue} FDJ) n'est pas payée à la caisse.`,
            409,
            { invoiceNumber: inv.number, amountDue: inv.amountDue },
          );
        if (!unpaidReason || unpaidReason.trim().length < 5)
          throw new DomainError(
            "unpaid_reason_required",
            "Un motif écrit est obligatoire pour une sortie avec facture impayée.",
            400,
          );
        exitedUnpaid = true;
      }
    }
    await tx.query(
      "update hosp.stays set status = 'discharged', exited_at = now(), exited_by = $2, exit_unpaid_reason = $3 where id = $1",
      [stayId, ctx.user.id, exitedUnpaid ? unpaidReason : null],
    );
    // Le forfait initial est terminé : le ticket se clôture si l'auteur de la sortie sert l'hospitalisation.
    if (canServeDepartment(ctx.user.roles, "HOSP")) {
      const ticket = (await ticketsOf(tx, stay.initial_order_id)).find(
        (t) => t.departmentCode === "HOSP",
      );
      if (ticket?.status === "in_progress") await completeTicketIn(tx, ctx, ticket.id);
    }
    await writeAudit(tx, ctx, {
      action: "stay.exit",
      entityType: "stay",
      entityId: stayId,
      patientId: stay.patient_id,
      detail: { number: stay.number, exitedUnpaid, reason: exitedUnpaid ? unpaidReason : null },
    });
    await appendEvent(tx, ctx, {
      type: "StayDischarged",
      patientId: stay.patient_id,
      payload: {
        stayId,
        stayNumber: stay.number,
        nights: stay.nights ?? 1,
        finalInvoiceId: stay.final_invoice_id,
        exitedUnpaid,
        exitedBy: person(ctx),
      },
    });
    return toStay(await lockStay(tx, stayId));
  });
}
