import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { can } from "../../auth/permissions.ts";
import { toCsv } from "../../common/csv.ts";
import { allocate, LOCAL_OFFSET_HOURS, splitAmount } from "../../common/money.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import {
  patientSummaries,
  relatedPatientIds,
  requireActivePatient,
  type PatientSummary,
} from "../identity/interface.ts";
import {
  getActs,
  requireAct,
  requireDepartment,
  requirePayer,
  type Act,
  type Payer,
} from "../catalog/service.ts";
import type { AdmitInput, PayInput } from "./schemas.ts";

/* ------------------------------------------------------------------ types */

export interface InvoiceLine {
  actCode: string;
  labelFr: string;
  labelAr: string;
  departmentCode: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface Invoice {
  id: string;
  kind: "invoice" | "credit_note";
  number: string;
  encounterId: string | null;
  orderId: string | null;
  orderNumber: string | null;
  patientId: string;
  payerCode: string;
  total: number;
  patientAmount: number;
  payerAmount: number;
  status: "pending" | "paid" | "credited";
  creditOf: string | null;
  creditReason: string | null;
  issuedAt: string;
  issuedBy: string;
  paidAt: string | null;
  /** Remise accordée à la caisse avant paiement (le patient paie `amountDue`). */
  discount: {
    amount: number;
    percent: number | null;
    reason: string;
    by: string;
    at: string;
  } | null;
  amountDue: number;
  lines?: InvoiceLine[];
  patient?: PatientSummary;
}

interface InvoiceRow {
  id: string;
  kind: "invoice" | "credit_note";
  number: string;
  encounter_id: string | null;
  order_id: string | null;
  order_number: string | null;
  patient_id: string;
  payer_code: string;
  total: number;
  patient_amount: number;
  payer_amount: number;
  status: "pending" | "paid" | "credited";
  credit_of: string | null;
  credit_reason: string | null;
  issued_at: Date;
  issued_by: string;
  paid_at: Date | null;
  discount_amount: number;
  discount_percent: string | null;
  discount_reason: string | null;
  discount_by: string | null;
  discount_at: Date | null;
}

const INVOICE_COLUMNS = `id, kind, number, encounter_id, order_id, order_number, patient_id, payer_code, total,
  patient_amount, payer_amount, status, credit_of, credit_reason, issued_at, issued_by, paid_at,
  discount_amount, discount_percent, discount_reason, discount_by, discount_at`;

const toInvoice = (r: InvoiceRow): Invoice => ({
  id: r.id,
  kind: r.kind,
  number: r.number,
  encounterId: r.encounter_id,
  orderId: r.order_id,
  orderNumber: r.order_number,
  patientId: r.patient_id,
  payerCode: r.payer_code,
  total: r.total,
  patientAmount: r.patient_amount,
  payerAmount: r.payer_amount,
  status: r.status,
  creditOf: r.credit_of,
  creditReason: r.credit_reason,
  issuedAt: r.issued_at.toISOString(),
  issuedBy: r.issued_by,
  paidAt: r.paid_at ? r.paid_at.toISOString() : null,
  discount:
    r.discount_amount > 0 && r.discount_reason && r.discount_by && r.discount_at
      ? {
          amount: r.discount_amount,
          percent: r.discount_percent === null ? null : Number(r.discount_percent),
          reason: r.discount_reason,
          by: r.discount_by,
          at: r.discount_at.toISOString(),
        }
      : null,
  amountDue: r.patient_amount - r.discount_amount,
});

interface LineRow {
  act_code: string;
  label_fr: string;
  label_ar: string;
  department_code: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

const toLine = (r: LineRow): InvoiceLine => ({
  actCode: r.act_code,
  labelFr: r.label_fr,
  labelAr: r.label_ar,
  departmentCode: r.department_code,
  unitPrice: r.unit_price,
  quantity: r.quantity,
  lineTotal: r.line_total,
});

async function linesOf(tx: Tx | Db, invoiceId: string): Promise<InvoiceLine[]> {
  const res = await tx.query<LineRow>(
    `select act_code, label_fr, label_ar, department_code, unit_price, quantity, line_total
       from billing.invoice_lines where invoice_id = $1 order by id`,
    [invoiceId],
  );
  return res.rows.map(toLine);
}

/* ------------------------------------------------------------------ interface pour les autres modules */

export interface EncounterSummary {
  id: string;
  patientId: string;
  departmentCode: string;
  payerCode: string;
  status: "open" | "closed";
}

export async function getEncounter(tx: Tx | Db, id: string): Promise<EncounterSummary> {
  const res = await tx.query<{
    id: string;
    patient_id: string;
    department_code: string;
    payer_code: string;
    status: "open" | "closed";
  }>(
    "select id, patient_id, department_code, payer_code, status from billing.encounters where id = $1",
    [id],
  );
  const r = res.rows[0];
  if (!r) throw notFound("Admission");
  return {
    id: r.id,
    patientId: r.patient_id,
    departmentCode: r.department_code,
    payerCode: r.payer_code,
    status: r.status,
  };
}

export interface InvoiceSummary {
  number: string;
  status: "pending" | "paid" | "credited";
  patientAmount: number;
  paidAt: string | null;
  receiptNumber: string | null;
  cashier: { id: string; name: string | null } | null;
}

/** Facture d'une demande de prestations, avec le reçu et la personne de la caisse si elle est payée. */
export async function getInvoiceSummaryForOrder(
  tx: Tx | Db,
  orderId: string,
): Promise<InvoiceSummary | null> {
  const res = await tx.query<{
    number: string;
    status: "pending" | "paid" | "credited";
    patient_amount: number;
    paid_at: Date | null;
    receipt_number: string | null;
    cashier_id: string | null;
    cashier_name: string | null;
  }>(
    `select i.number, i.status, i.patient_amount, i.paid_at, p.receipt_number, p.cashier_id, p.cashier_name
       from billing.invoices i left join billing.payments p on p.invoice_id = i.id
      where i.order_id = $1 and i.kind = 'invoice'`,
    [orderId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    number: r.number,
    status: r.status,
    patientAmount: r.patient_amount,
    paidAt: r.paid_at ? r.paid_at.toISOString() : null,
    receiptNumber: r.receipt_number,
    cashier: r.cashier_id ? { id: r.cashier_id, name: r.cashier_name } : null,
  };
}

/* ------------------------------------------------------------------ émission d'une facture */

export interface NewInvoiceLine {
  act: Pick<Act, "code" | "labelFr" | "labelAr" | "departmentCode">;
  unitPrice: number;
  quantity: number;
}

export async function issueInvoice(
  tx: Tx,
  ctx: RequestContext,
  input: {
    encounterId: string | null;
    orderId?: string | null;
    orderNumber?: string | null;
    patientId: string;
    payer: Payer;
    lines: NewInvoiceLine[];
  },
): Promise<Invoice> {
  const lines = input.lines.map((l) => ({ ...l, lineTotal: l.unitPrice * l.quantity }));
  const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const { patientAmount, payerAmount } = splitAmount(total, input.payer.patientShare);
  const number = await nextNumber(tx, "billing", "invoice", "F");
  const res = await tx.query<InvoiceRow>(
    `insert into billing.invoices
       (kind, number, encounter_id, order_id, order_number, patient_id, payer_code, total, patient_amount, payer_amount, issued_by)
     values ('invoice', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${INVOICE_COLUMNS}`,
    [
      number,
      input.encounterId,
      input.orderId ?? null,
      input.orderNumber ?? null,
      input.patientId,
      input.payer.code,
      total,
      patientAmount,
      payerAmount,
      ctx.user.id,
    ],
  );
  const invoice = toInvoice(res.rows[0] as InvoiceRow);
  for (const l of lines) {
    await tx.query(
      `insert into billing.invoice_lines
         (invoice_id, act_code, label_fr, label_ar, department_code, unit_price, quantity, line_total)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        invoice.id,
        l.act.code,
        l.act.labelFr,
        l.act.labelAr,
        l.act.departmentCode,
        l.unitPrice,
        l.quantity,
        l.lineTotal,
      ],
    );
  }
  invoice.lines = lines.map((l) => ({
    actCode: l.act.code,
    labelFr: l.act.labelFr,
    labelAr: l.act.labelAr,
    departmentCode: l.act.departmentCode,
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    lineTotal: l.lineTotal,
  }));
  await writeAudit(tx, ctx, {
    action: "invoice.issue",
    entityType: "invoice",
    entityId: invoice.id,
    patientId: invoice.patientId,
    detail: { number: invoice.number, total, patientAmount, orderNumber: invoice.orderNumber },
  });
  await appendEvent(tx, ctx, {
    type: "InvoiceIssued",
    patientId: invoice.patientId,
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      encounterId: invoice.encounterId,
      orderId: invoice.orderId,
      total,
      patientAmount,
      payerAmount,
    },
  });
  return invoice;
}

/* ------------------------------------------------------------------ admission (F2-1) */

export async function admit(
  db: Db,
  ctx: RequestContext,
  input: AdmitInput,
): Promise<{ encounter: EncounterSummary; invoice: Invoice }> {
  return withTransaction(db, async (tx) => {
    const patient = await requireActivePatient(tx, input.patientId);
    const department = await requireDepartment(tx, input.departmentCode);
    const payer = await requirePayer(tx, input.payerCode);
    const act = await requireAct(tx, input.actCode);
    if (act.category !== "consultation") {
      throw new DomainError(
        "act_not_admission",
        "L'admission se fait sur un acte de consultation.",
        400,
      );
    }
    if (act.departmentCode !== department.code) {
      throw new DomainError(
        "act_department_mismatch",
        "Cet acte n'appartient pas au service choisi.",
        400,
      );
    }
    const open = await tx.query<{ id: string }>(
      `select id from billing.encounters
        where patient_id = $1 and department_code = $2 and status = 'open'`,
      [patient.id, department.code],
    );
    if (open.rows[0]) {
      throw new DomainError(
        "encounter_already_open",
        "Ce patient est déjà admis dans ce service.",
        409,
        {
          encounterId: open.rows[0].id,
        },
      );
    }
    const enc = await tx.query<{ id: string }>(
      `insert into billing.encounters (patient_id, department_code, payer_code, opened_by)
       values ($1, $2, $3, $4) returning id`,
      [patient.id, department.code, payer.code, ctx.user.id],
    );
    const encounterId = (enc.rows[0] as { id: string }).id;
    await writeAudit(tx, ctx, {
      action: "encounter.open",
      entityType: "encounter",
      entityId: encounterId,
      patientId: patient.id,
      detail: { departmentCode: department.code, payerCode: payer.code },
    });
    const invoice = await issueInvoice(tx, ctx, {
      encounterId,
      patientId: patient.id,
      payer,
      lines: [{ act, unitPrice: act.tariff, quantity: 1 }],
    });
    await appendEvent(tx, ctx, {
      type: "EncounterStarted",
      patientId: patient.id,
      payload: {
        encounterId,
        departmentCode: department.code,
        payerCode: payer.code,
        invoiceId: invoice.id,
      },
    });
    return {
      encounter: {
        id: encounterId,
        patientId: patient.id,
        departmentCode: department.code,
        payerCode: payer.code,
        status: "open",
      },
      invoice,
    };
  });
}

/** Devis avant l'acte : montants calculés, rien n'est enregistré. */
export async function quote(
  db: Db,
  input: { payerCode: string; items: { actCode: string; quantity: number }[] },
): Promise<{ lines: InvoiceLine[]; total: number; patientAmount: number; payerAmount: number }> {
  const payer = await requirePayer(db, input.payerCode);
  const acts = await getActs(
    db,
    input.items.map((i) => i.actCode),
  );
  const lines: InvoiceLine[] = input.items.map((i) => {
    const act = acts.get(i.actCode);
    if (!act || !act.active) throw notFound(`Acte ${i.actCode}`);
    return {
      actCode: act.code,
      labelFr: act.labelFr,
      labelAr: act.labelAr,
      departmentCode: act.departmentCode,
      unitPrice: act.tariff,
      quantity: i.quantity,
      lineTotal: act.tariff * i.quantity,
    };
  });
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  return { lines, total, ...splitAmount(total, payer.patientShare) };
}

/* ------------------------------------------------------------------ caisse */

export interface CashSession {
  id: string;
  cashierId: string;
  openedAt: string;
  closedAt: string | null;
  expectedCash: number | null;
  countedCash: number | null;
  difference: number | null;
}

interface SessionRow {
  id: string;
  cashier_id: string;
  opened_at: Date;
  closed_at: Date | null;
  expected_cash: number | null;
  counted_cash: number | null;
  difference: number | null;
}

const toSession = (r: SessionRow): CashSession => ({
  id: r.id,
  cashierId: r.cashier_id,
  openedAt: r.opened_at.toISOString(),
  closedAt: r.closed_at ? r.closed_at.toISOString() : null,
  expectedCash: r.expected_cash,
  countedCash: r.counted_cash,
  difference: r.difference,
});

const SESSION_COLUMNS =
  "id, cashier_id, opened_at, closed_at, expected_cash, counted_cash, difference";

export async function currentCashSession(
  db: Db | Tx,
  cashierId: string,
): Promise<CashSession | null> {
  const res = await db.query<SessionRow>(
    `select ${SESSION_COLUMNS} from billing.cash_sessions where cashier_id = $1 and closed_at is null`,
    [cashierId],
  );
  return res.rows[0] ? toSession(res.rows[0]) : null;
}

export async function openCashSession(db: Db, ctx: RequestContext): Promise<CashSession> {
  return withTransaction(db, async (tx) => {
    if (await currentCashSession(tx, ctx.user.id)) {
      throw new DomainError("cash_session_open", "Votre caisse est déjà ouverte.", 409);
    }
    const res = await tx.query<SessionRow>(
      `insert into billing.cash_sessions (cashier_id, cashier_name) values ($1, $2) returning ${SESSION_COLUMNS}`,
      [ctx.user.id, ctx.user.name],
    );
    const session = toSession(res.rows[0] as SessionRow);
    await writeAudit(tx, ctx, {
      action: "cash.open",
      entityType: "cash_session",
      entityId: session.id,
    });
    return session;
  });
}

/** Clôture journalière : l'écart entre les espèces attendues et comptées est enregistré. */
export async function closeCashSession(
  db: Db,
  ctx: RequestContext,
  sessionId: string,
  countedCash: number,
): Promise<CashSession> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<SessionRow>(
      `select ${SESSION_COLUMNS} from billing.cash_sessions where id = $1 for update`,
      [sessionId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Session de caisse");
    if (row.cashier_id !== ctx.user.id) {
      throw new DomainError("forbidden", "Cette caisse n'est pas la vôtre.", 403);
    }
    if (row.closed_at)
      throw new DomainError("cash_session_closed", "Cette caisse est déjà clôturée.", 409);
    const cash = await tx.query<{ sum: string | null }>(
      "select sum(amount) as sum from billing.payments where cash_session_id = $1 and method = 'cash'",
      [sessionId],
    );
    const expected = Number(cash.rows[0]?.sum ?? 0);
    const res = await tx.query<SessionRow>(
      `update billing.cash_sessions set closed_at = now(), expected_cash = $2, counted_cash = $3, difference = $4
        where id = $1 returning ${SESSION_COLUMNS}`,
      [sessionId, expected, countedCash, countedCash - expected],
    );
    const session = toSession(res.rows[0] as SessionRow);
    await writeAudit(tx, ctx, {
      action: "cash.close",
      entityType: "cash_session",
      entityId: session.id,
      detail: { expected, counted: countedCash, difference: countedCash - expected },
    });
    return session;
  });
}

/* ------------------------------------------------------------------ paiement : la validation de la caisse */

export interface Payment {
  id: string;
  invoiceId: string;
  amount: number;
  method: "cash" | "mobile" | "card" | "exempt";
  receiptNumber: string;
  cashierId: string;
  cashierName: string | null;
  paidAt: string;
}

/**
 * La caisse encaisse la part du patient et valide le paiement. C'est cet acte, et lui seul, qui
 * déclenche (par l'événement InvoicePaid) l'envoi des tickets aux services concernés.
 */
export async function payInvoice(
  db: Db,
  ctx: RequestContext,
  invoiceId: string,
  input: PayInput,
): Promise<{ invoice: Invoice; payment: Payment; change: number }> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from billing.invoices where id = $1 for update`,
      [invoiceId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Facture");
    if (row.kind !== "invoice")
      throw new DomainError("not_payable", "Un avoir ne se paie pas.", 400);
    if (row.status === "paid")
      throw new DomainError("already_paid", "Cette facture est déjà payée.", 409);
    if (row.status === "credited")
      throw new DomainError("credited", "Cette facture a été annulée par un avoir.", 409);

    const session = await currentCashSession(tx, ctx.user.id);
    if (!session)
      throw new DomainError("no_cash_session", "Ouvrez votre caisse avant d'encaisser.", 409);

    const due = row.patient_amount - row.discount_amount;
    if (due === 0 && input.method !== "exempt") {
      throw new DomainError("use_exempt", "Rien à encaisser : validez en « exempt ».", 400);
    }
    if (due > 0 && input.method === "exempt") {
      throw new DomainError(
        "exempt_not_allowed",
        "Un montant est dû : choisissez un mode de paiement.",
        400,
      );
    }
    let change = 0;
    if (input.method === "cash" && input.receivedAmount !== undefined) {
      if (input.receivedAmount < due) {
        throw new DomainError("insufficient_amount", `Montant insuffisant : ${due} FDJ dus.`, 400, {
          due,
        });
      }
      change = input.receivedAmount - due;
    }

    const receiptNumber = await nextNumber(tx, "billing", "receipt", "R");
    const pay = await tx.query<{ id: string; paid_at: Date }>(
      `insert into billing.payments (invoice_id, amount, method, receipt_number, cashier_id, cashier_name, cash_session_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, paid_at`,
      [invoiceId, due, input.method, receiptNumber, ctx.user.id, ctx.user.name, session.id],
    );
    const payRow = pay.rows[0] as { id: string; paid_at: Date };
    const updated = await tx.query<InvoiceRow>(
      `update billing.invoices set status = 'paid', paid_at = $2 where id = $1 returning ${INVOICE_COLUMNS}`,
      [invoiceId, payRow.paid_at],
    );
    const invoice = toInvoice(updated.rows[0] as InvoiceRow);
    const payment: Payment = {
      id: payRow.id,
      invoiceId,
      amount: due,
      method: input.method,
      receiptNumber,
      cashierId: ctx.user.id,
      cashierName: ctx.user.name,
      paidAt: payRow.paid_at.toISOString(),
    };
    await writeAudit(tx, ctx, {
      action: "invoice.pay",
      entityType: "invoice",
      entityId: invoiceId,
      patientId: invoice.patientId,
      detail: {
        number: invoice.number,
        amount: due,
        method: input.method,
        receiptNumber,
        orderNumber: invoice.orderNumber,
      },
    });
    await appendEvent(tx, ctx, {
      type: "InvoicePaid",
      patientId: invoice.patientId,
      payload: {
        invoiceId,
        invoiceNumber: invoice.number,
        encounterId: invoice.encounterId,
        orderId: invoice.orderId,
        amount: due,
        method: input.method,
        receiptNumber,
        validatedBy: { userId: ctx.user.id, name: ctx.user.name },
        paidAt: payment.paidAt,
      },
    });
    return { invoice, payment, change };
  });
}

/* ------------------------------------------------------------------ remise */

async function maxDiscountPercent(tx: Tx): Promise<number> {
  const r = await tx.query<{ value: string }>(
    "select value from billing.settings where key = 'max_discount_percent'",
  );
  return Number(r.rows[0]?.value ?? 0);
}

/**
 * Remise sur une facture en attente de paiement. La caisse peut accorder jusqu'au plafond fixé par la direction ;
 * au-delà, seule la direction (ou l'administration) le peut. Motif obligatoire ; tout est tracé.
 */
export async function applyDiscount(
  db: Db,
  ctx: RequestContext,
  invoiceId: string,
  input: { percent?: number | undefined; amount?: number | undefined; reason: string },
): Promise<Invoice> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from billing.invoices where id = $1 for update`,
      [invoiceId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Facture");
    if (row.kind !== "invoice" || row.status !== "pending")
      throw new DomainError(
        "discount_not_allowed",
        "Une remise ne s'accorde que sur une facture en attente de paiement.",
        409,
      );
    if ((input.percent === undefined) === (input.amount === undefined))
      throw new DomainError(
        "percent_or_amount",
        "Indiquez un pourcentage ou un montant, pas les deux.",
        400,
      );
    const amount =
      input.percent !== undefined
        ? Math.round((row.patient_amount * input.percent) / 100)
        : (input.amount as number);
    const percent =
      input.percent ??
      (row.patient_amount > 0 ? Math.round((amount / row.patient_amount) * 10000) / 100 : 0);
    if (amount > row.patient_amount)
      throw new DomainError(
        "discount_too_large",
        "La remise dépasse le montant à la charge du patient.",
        400,
      );
    if (amount < 0) throw new DomainError("bad_discount", "Remise invalide.", 400);
    const cap = await maxDiscountPercent(tx);
    if (percent > cap && !can(ctx.user.roles, "billing:discount-any"))
      throw new DomainError(
        "discount_needs_direction",
        `Remise supérieure à ${cap} % : elle doit être accordée par la direction.`,
        403,
        { maxPercent: cap, requestedPercent: percent },
      );
    await tx.query(
      `update billing.invoices set discount_amount = $2, discount_percent = $3, discount_reason = $4, discount_by = $5,
         discount_by_name = $6, discount_at = now() where id = $1`,
      [
        invoiceId,
        amount,
        amount === 0 ? null : percent,
        amount === 0 ? null : input.reason,
        amount === 0 ? null : ctx.user.id,
        ctx.user.name,
      ],
    );
    await writeAudit(tx, ctx, {
      action: "invoice.discount",
      entityType: "invoice",
      entityId: invoiceId,
      patientId: row.patient_id,
      detail: {
        number: row.number,
        amount,
        percent,
        reason: input.reason,
        previous: row.discount_amount,
      },
    });
    const updated = await tx.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from billing.invoices where id = $1`,
      [invoiceId],
    );
    return toInvoice(updated.rows[0] as InvoiceRow);
  });
}

/* ------------------------------------------------------------------ avoir (F2-4) */

export async function creditInvoice(
  db: Db,
  ctx: RequestContext,
  invoiceId: string,
  reason: string,
): Promise<{ original: Invoice; creditNote: Invoice }> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from billing.invoices where id = $1 for update`,
      [invoiceId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Facture");
    if (row.kind !== "invoice")
      throw new DomainError("not_creditable", "Un avoir ne se corrige pas.", 400);
    if (row.status === "credited")
      throw new DomainError("already_credited", "Cette facture a déjà un avoir.", 409);
    const lines = await linesOf(tx, invoiceId);
    const number = await nextNumber(tx, "billing", "credit_note", "A");
    const created = await tx.query<InvoiceRow>(
      `insert into billing.invoices
         (kind, number, encounter_id, order_id, order_number, patient_id, payer_code, total, patient_amount, payer_amount,
          status, credit_of, credit_reason, issued_by)
       values ('credit_note', $1, $2, null, $3, $4, $5, $6, $7, $8, 'paid', $9, $10, $11) returning ${INVOICE_COLUMNS}`,
      [
        number,
        row.encounter_id,
        row.order_number,
        row.patient_id,
        row.payer_code,
        -(row.patient_amount - row.discount_amount + row.payer_amount),
        -(row.patient_amount - row.discount_amount),
        -row.payer_amount,
        invoiceId,
        reason,
        ctx.user.id,
      ],
    );
    const creditNote = toInvoice(created.rows[0] as InvoiceRow);
    for (const l of lines) {
      await tx.query(
        `insert into billing.invoice_lines
           (invoice_id, act_code, label_fr, label_ar, department_code, unit_price, quantity, line_total)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          creditNote.id,
          l.actCode,
          l.labelFr,
          l.labelAr,
          l.departmentCode,
          l.unitPrice,
          -l.quantity,
          -l.lineTotal,
        ],
      );
    }
    const updated = await tx.query<InvoiceRow>(
      `update billing.invoices set status = 'credited' where id = $1 returning ${INVOICE_COLUMNS}`,
      [invoiceId],
    );
    const original = toInvoice(updated.rows[0] as InvoiceRow);
    await writeAudit(tx, ctx, {
      action: "invoice.credit",
      entityType: "invoice",
      entityId: invoiceId,
      patientId: original.patientId,
      detail: {
        number: original.number,
        creditNoteNumber: number,
        reason,
        wasPaid: row.status === "paid",
      },
    });
    await appendEvent(tx, ctx, {
      type: "InvoiceCredited",
      patientId: original.patientId,
      payload: {
        invoiceId,
        orderId: original.orderId,
        creditNoteId: creditNote.id,
        creditNoteNumber: number,
        reason,
      },
    });
    return { original, creditNote };
  });
}

/* ------------------------------------------------------------------ lectures */

export async function listInvoices(
  db: Db,
  filter: {
    status?: string;
    patientId?: string;
    orderNumber?: string;
    limit: number;
    newest?: boolean;
  },
): Promise<Invoice[]> {
  let patientIds: string[] | null = null;
  if (filter.patientId) {
    patientIds = await relatedPatientIds(db, filter.patientId);
  }
  const res = await db.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from billing.invoices
      where kind = 'invoice'
        and ($1::text is null or status = $1)
        and ($2::uuid[] is null or patient_id = any($2))
        and ($3::text is null or order_number = $3)
      order by ${filter.newest ? "issued_at desc, number desc" : "issued_at, number"} limit $4`,
    [filter.status ?? null, patientIds, filter.orderNumber ?? null, filter.limit],
  );
  const invoices = res.rows.map(toInvoice);
  const people = await patientSummaries(
    db,
    invoices.map((i) => i.patientId),
  );
  for (const inv of invoices) {
    const p = people.get(inv.patientId);
    if (p) inv.patient = p;
  }
  return invoices;
}

export async function getInvoice(db: Db, id: string): Promise<Invoice> {
  const res = await db.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from billing.invoices where id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Facture");
  const invoice = toInvoice(row);
  invoice.lines = await linesOf(db, id);
  const person = (await patientSummaries(db, [invoice.patientId])).get(invoice.patientId);
  if (person) invoice.patient = person;
  return invoice;
}

/** Reçu imprimable (français et arabe côté affichage : les deux libellés sont fournis). */
export async function getReceipt(db: Db, invoiceId: string) {
  const invoice = await getInvoice(db, invoiceId);
  const pay = await db.query<{
    receipt_number: string;
    method: string;
    amount: number;
    cashier_id: string;
    cashier_name: string | null;
    paid_at: Date;
  }>(
    "select receipt_number, method, amount, cashier_id, cashier_name, paid_at from billing.payments where invoice_id = $1",
    [invoiceId],
  );
  const p = pay.rows[0];
  if (!p)
    throw new DomainError("not_paid", "Cette facture n'est pas encore payée : pas de reçu.", 409);
  return {
    receiptNumber: p.receipt_number,
    paidAt: p.paid_at.toISOString(),
    method: p.method,
    amount: p.amount,
    cashier: { id: p.cashier_id, name: p.cashier_name },
    invoiceNumber: invoice.number,
    orderNumber: invoice.orderNumber,
    patient: invoice.patient ?? null,
    lines: invoice.lines ?? [],
    total: invoice.total,
    patientAmount: invoice.patientAmount,
    payerAmount: invoice.payerAmount,
    discount: invoice.discount,
    amountDue: invoice.amountDue,
  };
}

/* ------------------------------------------------------------------ rapport de recettes (F2-6) */

export interface RevenueRow {
  key: string;
  label: string;
  receipts: number;
  amount: number;
}

export interface RevenueReport {
  from: string;
  to: string;
  groupBy: "day" | "department" | "cashier";
  rows: RevenueRow[];
  /** Somme des reçus de la période : identique à la somme des lignes. */
  total: number;
  receiptCount: number;
  /** Montants rendus aux patients par des avoirs sur factures déjà payées, sur la même période. */
  credited: number;
}

export async function revenueReport(
  db: Db,
  input: { from: string; to: string; groupBy: "day" | "department" | "cashier" },
): Promise<RevenueReport> {
  // Les jours suivent l'heure locale de Djibouti.
  const range = `(p.paid_at + interval '${LOCAL_OFFSET_HOURS} hours')::date between $1::date and $2::date`;
  const pays = await db.query<{
    id: string;
    invoice_id: string;
    amount: number;
    day: string;
    cashier_id: string;
    cashier_name: string | null;
  }>(
    `select p.id, p.invoice_id, p.amount, ((p.paid_at + interval '${LOCAL_OFFSET_HOURS} hours')::date)::text as day,
            p.cashier_id, p.cashier_name
       from billing.payments p where ${range} order by p.paid_at`,
    [input.from, input.to],
  );
  const total = pays.rows.reduce((s, r) => s + r.amount, 0);
  const groups = new Map<string, RevenueRow>();
  const bump = (key: string, label: string, amount: number) => {
    const g = groups.get(key) ?? { key, label, receipts: 0, amount: 0 };
    g.receipts += 1;
    g.amount += amount;
    groups.set(key, g);
  };
  if (input.groupBy === "day") {
    for (const r of pays.rows) bump(r.day, r.day, r.amount);
  } else if (input.groupBy === "cashier") {
    for (const r of pays.rows) bump(r.cashier_id, r.cashier_name ?? r.cashier_id, r.amount);
  } else {
    // Par service : chaque paiement est réparti sur les lignes de sa facture, sans perte d'arrondi.
    const ids = pays.rows.map((r) => r.invoice_id);
    const lines = await db.query<{
      invoice_id: string;
      department_code: string;
      line_total: number;
    }>(
      "select invoice_id, department_code, line_total from billing.invoice_lines where invoice_id = any($1::uuid[]) order by id",
      [ids],
    );
    const byInvoice = new Map<string, { department_code: string; line_total: number }[]>();
    for (const l of lines.rows) {
      const list = byInvoice.get(l.invoice_id) ?? [];
      list.push(l);
      byInvoice.set(l.invoice_id, list);
    }
    for (const r of pays.rows) {
      const ls = byInvoice.get(r.invoice_id) ?? [];
      const shares = allocate(
        r.amount,
        ls.map((l) => l.line_total),
      );
      const seen = new Set<string>();
      ls.forEach((l, i) => {
        const amount = shares[i] ?? 0;
        const g = groups.get(l.department_code) ?? {
          key: l.department_code,
          label: l.department_code,
          receipts: 0,
          amount: 0,
        };
        g.amount += amount;
        if (!seen.has(l.department_code)) {
          g.receipts += 1;
          seen.add(l.department_code);
        }
        groups.set(l.department_code, g);
      });
    }
  }
  const credited = await db.query<{ sum: string | null }>(
    `select sum(-c.patient_amount) as sum
       from billing.invoices c join billing.invoices o on o.id = c.credit_of
       join billing.payments p on p.invoice_id = o.id
      where c.kind = 'credit_note'
        and (c.issued_at + interval '${LOCAL_OFFSET_HOURS} hours')::date between $1::date and $2::date`,
    [input.from, input.to],
  );
  return {
    from: input.from,
    to: input.to,
    groupBy: input.groupBy,
    rows: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
    total,
    receiptCount: pays.rows.length,
    credited: Number(credited.rows[0]?.sum ?? 0),
  };
}

export function revenueCsv(report: RevenueReport): string {
  return toCsv([
    ["groupe", "libelle", "recus", "montant_fdj"],
    ...report.rows.map((r) => [r.key, r.label, r.receipts, r.amount]),
    ["TOTAL", "", report.receiptCount, report.total],
  ]);
}
