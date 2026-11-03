import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { canServeDepartment } from "../../auth/permissions.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { getActs } from "../catalog/service.ts";
import { getEncounter, getInvoiceSummaryForOrder } from "../billing/service.ts";
import { checkDigits } from "../identity/card.ts";
import {
  patientSummaries,
  relatedPatientIds,
  requireActivePatient,
  type PatientSummary,
} from "../identity/interface.ts";
import type { PlaceOrderInput } from "./schemas.ts";

/**
 * Demandes de prestations du médecin avec paiement préalable à la caisse (ADR-0002).
 *
 *   médecin demande -> « en attente de paiement » -> la caisse encaisse et valide
 *   -> un ticket part à chaque service concerné -> le service active la prestation.
 *
 * Aucun ticket n'existe avant la validation de la caisse : sans ticket, un service ne peut rien activer.
 */

/* ------------------------------------------------------------------ types */

export interface OrderItem {
  actCode: string;
  labelFr: string;
  labelAr: string;
  quantity: number;
  unitPrice: number;
  departmentCode: string;
}

export interface ServiceOrder {
  id: string;
  number: string;
  patientId: string;
  encounterId: string;
  status: "awaiting_payment" | "released" | "completed" | "cancelled";
  placedBy: { id: string; name: string | null };
  placedAt: string;
  note: string | null;
  releasedAt: string | null;
  releasedBy: { id: string; name: string | null } | null;
  items?: OrderItem[];
  patient?: PatientSummary;
}

interface OrderRow {
  id: string;
  number: string;
  patient_id: string;
  encounter_id: string;
  status: ServiceOrder["status"];
  placed_by: string;
  placed_by_name: string | null;
  placed_at: Date;
  note: string | null;
  released_at: Date | null;
  released_by: string | null;
  released_by_name: string | null;
}

const ORDER_COLUMNS = `id, number, patient_id, encounter_id, status, placed_by, placed_by_name, placed_at, note,
  released_at, released_by, released_by_name`;

const toOrder = (r: OrderRow): ServiceOrder => ({
  id: r.id,
  number: r.number,
  patientId: r.patient_id,
  encounterId: r.encounter_id,
  status: r.status,
  placedBy: { id: r.placed_by, name: r.placed_by_name },
  placedAt: r.placed_at.toISOString(),
  note: r.note,
  releasedAt: r.released_at ? r.released_at.toISOString() : null,
  releasedBy: r.released_by ? { id: r.released_by, name: r.released_by_name } : null,
});

export interface Ticket {
  id: string;
  orderId: string;
  code: string;
  payload: string;
  departmentCode: string;
  status: "sent" | "in_progress" | "completed" | "cancelled";
  releasedAt: string;
  releasedBy: { id: string; name: string | null };
  startedBy: { id: string; name: string | null } | null;
  startedAt: string | null;
  completedBy: { id: string; name: string | null } | null;
  completedAt: string | null;
}

interface TicketRow {
  id: string;
  order_id: string;
  code: string;
  department_code: string;
  status: Ticket["status"];
  released_at: Date;
  released_by: string;
  released_by_name: string | null;
  started_by: string | null;
  started_by_name: string | null;
  started_at: Date | null;
  completed_by: string | null;
  completed_by_name: string | null;
  completed_at: Date | null;
}

const TICKET_COLUMNS = `id, order_id, code, department_code, status, released_at, released_by, released_by_name,
  started_by, started_by_name, started_at, completed_by, completed_by_name, completed_at`;

/** Contenu du code-barres ou QR du ticket : le code et une clé de contrôle, rien d'autre. */
export const ticketPayload = (code: string): string => `TK1.${code}.${checkDigits(code)}`;

const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  orderId: r.order_id,
  code: r.code,
  payload: ticketPayload(r.code),
  departmentCode: r.department_code,
  status: r.status,
  releasedAt: r.released_at.toISOString(),
  releasedBy: { id: r.released_by, name: r.released_by_name },
  startedBy: r.started_by ? { id: r.started_by, name: r.started_by_name } : null,
  startedAt: r.started_at ? r.started_at.toISOString() : null,
  completedBy: r.completed_by ? { id: r.completed_by, name: r.completed_by_name } : null,
  completedAt: r.completed_at ? r.completed_at.toISOString() : null,
});

/* ------------------------------------------------------------------ trace */

export interface Actor {
  id: string;
  name: string | null;
  role: string | null;
}

export async function recordStep(
  tx: Tx,
  orderId: string,
  step: string,
  actor: Actor,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `insert into orders.order_events (order_id, step, actor_id, actor_name, actor_role, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [orderId, step, actor.id, actor.name, actor.role, JSON.stringify(detail)],
  );
}

const actorOf = (ctx: RequestContext): Actor => ({
  id: ctx.user.id,
  name: ctx.user.name,
  role: ctx.user.roles[0] ?? null,
});

async function itemsOf(tx: Tx | Db, orderId: string): Promise<OrderItem[]> {
  const res = await tx.query<{
    act_code: string;
    label_fr: string;
    label_ar: string;
    quantity: number;
    unit_price: number;
    department_code: string;
  }>(
    `select act_code, label_fr, label_ar, quantity, unit_price, department_code
       from orders.service_order_items where order_id = $1 order by id`,
    [orderId],
  );
  return res.rows.map((r) => ({
    actCode: r.act_code,
    labelFr: r.label_fr,
    labelAr: r.label_ar,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    departmentCode: r.department_code,
  }));
}

/* ------------------------------------------------------------------ demande du médecin */

export async function placeOrder(
  db: Db,
  ctx: RequestContext,
  input: PlaceOrderInput,
): Promise<ServiceOrder> {
  return withTransaction(db, (tx) => placeOrderIn(tx, ctx, input));
}

/** Même chose dans la transaction de l'appelant (l'hospitalisation lie la demande à un séjour). */
export async function placeOrderIn(
  tx: Tx,
  ctx: RequestContext,
  input: PlaceOrderInput,
): Promise<ServiceOrder> {
  {
    const patient = await requireActivePatient(tx, input.patientId);
    const encounter = await getEncounter(tx, input.encounterId);
    const family = await relatedPatientIds(tx, patient.id);
    if (!family.includes(encounter.patientId)) {
      throw new DomainError(
        "encounter_mismatch",
        "Cette admission n'appartient pas à ce patient.",
        400,
      );
    }
    if (encounter.status !== "open") {
      throw new DomainError("encounter_closed", "Cette admission est clôturée.", 409);
    }
    // Les actes identiques sont regroupés.
    const wanted = new Map<string, number>();
    for (const i of input.items) wanted.set(i.actCode, (wanted.get(i.actCode) ?? 0) + i.quantity);
    const acts = await getActs(tx, [...wanted.keys()]);
    const items: OrderItem[] = [];
    for (const [code, quantity] of wanted) {
      const act = acts.get(code);
      if (!act) throw notFound(`Acte ${code}`);
      if (!act.active)
        throw new DomainError("act_inactive", `L'acte ${code} n'est plus proposé.`, 409);
      if (act.category === "consultation") {
        throw new DomainError(
          "act_not_orderable",
          `L'acte ${code} se règle à l'admission, pas par une demande.`,
          400,
        );
      }
      items.push({
        actCode: act.code,
        labelFr: act.labelFr,
        labelAr: act.labelAr,
        quantity,
        unitPrice: act.tariff,
        departmentCode: act.departmentCode,
      });
    }
    const number = await nextNumber(tx, "orders", "order", "O");
    const created = await tx.query<OrderRow>(
      `insert into orders.service_orders (number, patient_id, encounter_id, placed_by, placed_by_name, note)
       values ($1, $2, $3, $4, $5, $6) returning ${ORDER_COLUMNS}`,
      [number, patient.id, encounter.id, ctx.user.id, ctx.user.name, input.note ?? null],
    );
    const order = toOrder(created.rows[0] as OrderRow);
    for (const i of items) {
      await tx.query(
        `insert into orders.service_order_items
           (order_id, act_code, label_fr, label_ar, quantity, unit_price, department_code)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, i.actCode, i.labelFr, i.labelAr, i.quantity, i.unitPrice, i.departmentCode],
      );
    }
    order.items = items;
    await recordStep(tx, order.id, "placed", actorOf(ctx), {
      items: items.map((i) => ({
        actCode: i.actCode,
        quantity: i.quantity,
        departmentCode: i.departmentCode,
      })),
    });
    await writeAudit(tx, ctx, {
      action: "order.place",
      entityType: "service_order",
      entityId: order.id,
      patientId: patient.id,
      detail: { number, departments: [...new Set(items.map((i) => i.departmentCode))] },
    });
    await appendEvent(tx, ctx, {
      type: "ServiceOrderPlaced",
      patientId: patient.id,
      payload: {
        orderId: order.id,
        orderNumber: number,
        encounterId: encounter.id,
        placedBy: { userId: ctx.user.id, name: ctx.user.name },
        items: items.map((i) => ({
          actCode: i.actCode,
          quantity: i.quantity,
          departmentCode: i.departmentCode,
          unitPrice: i.unitPrice,
        })),
      },
    });
    return order;
  }
}

/* ------------------------------------------------------------------ lectures */

export async function listOrders(
  db: Db | Tx,
  filter: { patientId?: string; status?: string; limit: number },
): Promise<ServiceOrder[]> {
  const ids = filter.patientId ? await relatedPatientIds(db, filter.patientId) : null;
  const res = await db.query<OrderRow>(
    `select ${ORDER_COLUMNS} from orders.service_orders
      where ($1::uuid[] is null or patient_id = any($1)) and ($2::text is null or status = $2)
      order by placed_at desc, number desc limit $3`,
    [ids, filter.status ?? null, filter.limit],
  );
  const orders = res.rows.map(toOrder);
  const people = await patientSummaries(
    db,
    orders.map((o) => o.patientId),
  );
  for (const o of orders) {
    const p = people.get(o.patientId);
    if (p) o.patient = p;
  }
  return orders;
}

export async function getOrder(db: Db, id: string): Promise<ServiceOrder> {
  const res = await db.query<OrderRow>(
    `select ${ORDER_COLUMNS} from orders.service_orders where id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Demande de prestations");
  const order = toOrder(row);
  order.items = await itemsOf(db, id);
  const p = (await patientSummaries(db, [order.patientId])).get(order.patientId);
  if (p) order.patient = p;
  return order;
}

export async function ticketsOf(db: Db | Tx, orderId: string): Promise<Ticket[]> {
  const res = await db.query<TicketRow>(
    `select ${TICKET_COLUMNS} from orders.department_tickets where order_id = $1 order by department_code`,
    [orderId],
  );
  return res.rows.map(toTicket);
}

export interface TraceStep {
  at: string;
  step: string;
  actor: Actor;
  detail: Record<string, unknown>;
}

/**
 * Qui a demandé, qui a validé à la caisse, si le ticket est parti au service concerné, qui a exécuté.
 */
export async function getTrace(db: Db, orderId: string) {
  const order = await getOrder(db, orderId);
  const steps = await db.query<{
    at: Date;
    step: string;
    actor_id: string;
    actor_name: string | null;
    actor_role: string | null;
    detail: Record<string, unknown>;
  }>(
    "select at, step, actor_id, actor_name, actor_role, detail from orders.order_events where order_id = $1 order by id",
    [orderId],
  );
  const tickets = await ticketsOf(db, orderId);
  return {
    order,
    invoice: await getInvoiceSummaryForOrder(db, orderId),
    tickets,
    sentToDepartments: tickets.length > 0,
    steps: steps.rows.map((s): TraceStep => ({
      at: s.at.toISOString(),
      step: s.step,
      actor: { id: s.actor_id, name: s.actor_name, role: s.actor_role },
      detail: s.detail,
    })),
  };
}

/** Le document remis au patient par la caisse : disponible seulement une fois le paiement validé. */
export async function getVoucher(db: Db, ctx: RequestContext, orderId: string) {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<OrderRow>(
      `select ${ORDER_COLUMNS} from orders.service_orders where id = $1 for update`,
      [orderId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Demande de prestations");
    if (row.status === "awaiting_payment") {
      throw new DomainError(
        "payment_required",
        "Le patient doit d'abord payer à la caisse : le bon de prestations n'est remis qu'après paiement.",
        409,
      );
    }
    if (row.status === "cancelled") {
      throw new DomainError("order_cancelled", "Cette demande a été annulée.", 409);
    }
    const order = toOrder(row);
    const items = await itemsOf(tx, orderId);
    const tickets = await ticketsOf(tx, orderId);
    const invoice = await getInvoiceSummaryForOrder(tx, orderId);
    const patient = (await patientSummaries(tx, [order.patientId])).get(order.patientId) ?? null;
    await recordStep(tx, orderId, "voucher_printed", actorOf(ctx), {});
    await writeAudit(tx, ctx, {
      action: "order.voucher",
      entityType: "service_order",
      entityId: orderId,
      patientId: order.patientId,
      detail: { number: order.number },
    });
    return {
      orderNumber: order.number,
      patient,
      receiptNumber: invoice?.receiptNumber ?? null,
      validatedBy: invoice?.cashier ?? null,
      instruction: {
        fr: "Présentez-vous dans chaque service indiqué avec ce bon.",
        ar: "توجه إلى كل قسم مذكور وبحوزتك هذه الوثيقة.",
      },
      services: [...new Set(items.map((i) => i.departmentCode))].map((department) => ({
        departmentCode: department,
        items: items.filter((i) => i.departmentCode === department),
        ticket: tickets.find((t) => t.departmentCode === department) ?? null,
      })),
    };
  });
}

/* ------------------------------------------------------------------ travail des services */

async function lockTicket(tx: Tx, id: string): Promise<{ ticket: TicketRow; order: OrderRow }> {
  const t = await tx.query<TicketRow>(
    `select ${TICKET_COLUMNS} from orders.department_tickets where id = $1 for update`,
    [id],
  );
  const ticket = t.rows[0];
  if (!ticket) throw notFound("Ticket");
  const o = await tx.query<OrderRow>(
    `select ${ORDER_COLUMNS} from orders.service_orders where id = $1 for update`,
    [ticket.order_id],
  );
  return { ticket, order: o.rows[0] as OrderRow };
}

function requireDepartmentAccess(ctx: RequestContext, department: string): void {
  if (!canServeDepartment(ctx.user.roles, department)) {
    throw new DomainError("wrong_department", "Ce ticket concerne un autre service.", 403);
  }
}

/** Tickets reçus par un service : seuls ceux libérés par la caisse existent. */
export async function listTickets(
  db: Db,
  ctx: RequestContext,
  filter: { department: string; status?: string },
): Promise<
  (Ticket & { orderNumber: string; patient: PatientSummary | null; items: OrderItem[] })[]
> {
  requireDepartmentAccess(ctx, filter.department);
  const res = await db.query<TicketRow & { order_number: string; patient_id: string }>(
    `select ${TICKET_COLUMNS.split(",")
      .map((c) => `t.${c.trim()}`)
      .join(", ")}, o.number as order_number, o.patient_id
       from orders.department_tickets t join orders.service_orders o on o.id = t.order_id
      where t.department_code = $1 and ($2::text is null or t.status = $2)
      order by t.released_at, t.code`,
    [filter.department, filter.status ?? null],
  );
  const people = await patientSummaries(
    db,
    res.rows.map((r) => r.patient_id),
  );
  const out = [];
  for (const r of res.rows) {
    const items = (await itemsOf(db, r.order_id)).filter(
      (i) => i.departmentCode === r.department_code,
    );
    out.push({
      ...toTicket(r),
      orderNumber: r.order_number,
      patient: people.get(r.patient_id) ?? null,
      items,
    });
  }
  return out;
}

/** Le service active la prestation : possible seulement avec un ticket libéré par la caisse. */
export async function startTicket(db: Db, ctx: RequestContext, ticketId: string): Promise<Ticket> {
  return withTransaction(db, (tx) => startTicketIn(tx, ctx, ticketId));
}

/** Même chose dans la transaction de l'appelant (le laboratoire démarre le ticket au premier prélèvement). */
export async function startTicketIn(
  tx: Tx,
  ctx: RequestContext,
  ticketId: string,
): Promise<Ticket> {
  {
    const { ticket, order } = await lockTicket(tx, ticketId);
    requireDepartmentAccess(ctx, ticket.department_code);
    if (ticket.status === "cancelled")
      throw new DomainError("ticket_cancelled", "Ce ticket est annulé.", 409);
    if (ticket.status !== "sent")
      throw new DomainError("already_started", "Cette prestation est déjà commencée.", 409);
    const res = await tx.query<TicketRow>(
      `update orders.department_tickets set status = 'in_progress', started_by = $2, started_by_name = $3, started_at = now()
        where id = $1 returning ${TICKET_COLUMNS}`,
      [ticketId, ctx.user.id, ctx.user.name],
    );
    const updated = toTicket(res.rows[0] as TicketRow);
    await recordStep(tx, order.id, "service_started", actorOf(ctx), {
      ticketCode: updated.code,
      departmentCode: updated.departmentCode,
    });
    await writeAudit(tx, ctx, {
      action: "ticket.start",
      entityType: "department_ticket",
      entityId: ticketId,
      patientId: order.patient_id,
      detail: { ticketCode: updated.code, departmentCode: updated.departmentCode },
    });
    await appendEvent(tx, ctx, {
      type: "DepartmentServiceStarted",
      patientId: order.patient_id,
      payload: {
        ticketId,
        ticketCode: updated.code,
        orderId: order.id,
        departmentCode: updated.departmentCode,
        by: { userId: ctx.user.id, name: ctx.user.name },
      },
    });
    return updated;
  }
}

export async function completeTicket(
  db: Db,
  ctx: RequestContext,
  ticketId: string,
): Promise<Ticket> {
  return withTransaction(db, (tx) => completeTicketIn(tx, ctx, ticketId));
}

export async function completeTicketIn(
  tx: Tx,
  ctx: RequestContext,
  ticketId: string,
): Promise<Ticket> {
  {
    const { ticket, order } = await lockTicket(tx, ticketId);
    requireDepartmentAccess(ctx, ticket.department_code);
    if (ticket.status !== "in_progress") {
      throw new DomainError("not_started", "La prestation doit d'abord être commencée.", 409);
    }
    const res = await tx.query<TicketRow>(
      `update orders.department_tickets set status = 'completed', completed_by = $2, completed_by_name = $3, completed_at = now()
        where id = $1 returning ${TICKET_COLUMNS}`,
      [ticketId, ctx.user.id, ctx.user.name],
    );
    const updated = toTicket(res.rows[0] as TicketRow);
    await recordStep(tx, order.id, "service_completed", actorOf(ctx), {
      ticketCode: updated.code,
      departmentCode: updated.departmentCode,
    });
    const open = await tx.query(
      "select 1 from orders.department_tickets where order_id = $1 and status in ('sent', 'in_progress')",
      [order.id],
    );
    if (!open.rowCount) {
      await tx.query("update orders.service_orders set status = 'completed' where id = $1", [
        order.id,
      ]);
      await recordStep(tx, order.id, "order_completed", actorOf(ctx), {});
    }
    await writeAudit(tx, ctx, {
      action: "ticket.complete",
      entityType: "department_ticket",
      entityId: ticketId,
      patientId: order.patient_id,
      detail: { ticketCode: updated.code, departmentCode: updated.departmentCode },
    });
    await appendEvent(tx, ctx, {
      type: "DepartmentServiceCompleted",
      patientId: order.patient_id,
      payload: {
        ticketId,
        ticketCode: updated.code,
        orderId: order.id,
        departmentCode: updated.departmentCode,
        by: { userId: ctx.user.id, name: ctx.user.name },
      },
    });
    return updated;
  }
}

/** Ticket, demande et prestations du service, pour les modules de service (laboratoire, imagerie). */
export async function ticketContext(tx: Tx | Db, ticketId: string) {
  const res = await tx.query<
    TicketRow & {
      order_number: string;
      patient_id: string;
      placed_by: string;
      placed_by_name: string | null;
    }
  >(
    `select ${TICKET_COLUMNS.split(",")
      .map((c) => `t.${c.trim()}`)
      .join(", ")}, o.number as order_number, o.patient_id, o.placed_by, o.placed_by_name
       from orders.department_tickets t join orders.service_orders o on o.id = t.order_id where t.id = $1`,
    [ticketId],
  );
  const r = res.rows[0];
  if (!r) throw notFound("Ticket");
  const items = (await itemsOf(tx, r.order_id)).filter(
    (i) => i.departmentCode === r.department_code,
  );
  return {
    ticket: toTicket(r),
    orderId: r.order_id,
    orderNumber: r.order_number,
    patientId: r.patient_id,
    placedBy: { id: r.placed_by, name: r.placed_by_name },
    items,
  };
}

/**
 * Garde pour les modules de service (laboratoire, imagerie, hospitalisation) : avant de créer un
 * prélèvement, un examen ou un séjour, ils vérifient qu'un ticket actif existe pour ce service.
 */
export async function assertActiveTicket(
  tx: Tx | Db,
  ticketCode: string,
  departmentCode: string,
): Promise<Ticket> {
  const res = await tx.query<TicketRow>(
    `select ${TICKET_COLUMNS} from orders.department_tickets where code = $1`,
    [ticketCode],
  );
  const row = res.rows[0];
  if (!row || row.department_code !== departmentCode) {
    throw new DomainError(
      "ticket_required",
      "Aucun ticket libéré par la caisse pour ce service.",
      409,
    );
  }
  if (row.status === "cancelled" || row.status === "completed") {
    throw new DomainError("ticket_not_active", "Ce ticket n'est plus actif.", 409);
  }
  return toTicket(row);
}
