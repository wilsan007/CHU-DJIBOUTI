import { writeAudit } from "../../audit/audit.ts";
import { nextNumber } from "../../common/numbering.ts";
import { appendEvent } from "../../events/outbox.ts";
import type { Consumer } from "../../events/dispatcher.ts";
import { ticketPayload, recordStep } from "./service.ts";

interface LockedOrder {
  id: string;
  number: string;
  patient_id: string;
  status: "awaiting_payment" | "released" | "completed" | "cancelled";
}

/**
 * LA RÈGLE DE LA CAISSE : quand la caisse a encaissé et validé la facture d'une demande, et seulement alors,
 * un ticket est créé et envoyé à chaque service concerné. La validation (qui, quand) et l'envoi sont tracés.
 */
export const releaseOnPayment: Consumer = {
  name: "orders.release-on-payment",
  types: ["InvoicePaid"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "InvoicePaid" || !event.payload.orderId) return;
    const { orderId, validatedBy, invoiceNumber, receiptNumber, amount, method, paidAt } =
      event.payload;

    const found = await tx.query<LockedOrder>(
      "select id, number, patient_id, status from orders.service_orders where id = $1 for update",
      [orderId],
    );
    const order = found.rows[0];
    if (!order) throw new Error(`Demande ${orderId} introuvable pour la facture ${invoiceNumber}`);

    const cashier = { id: validatedBy.userId, name: validatedBy.name ?? null, role: "cashier" };
    if (order.status === "cancelled") {
      await recordStep(tx, order.id, "payment_on_cancelled_order", cashier, {
        invoiceNumber,
        receiptNumber,
        amount,
      });
      return;
    }
    if (order.status !== "awaiting_payment") return; // déjà libérée : rien à refaire

    await recordStep(tx, order.id, "payment_validated", cashier, {
      invoiceNumber,
      receiptNumber,
      amount,
      method,
      paidAt,
    });
    await tx.query(
      `update orders.service_orders
          set status = 'released', released_at = now(), released_by = $2, released_by_name = $3
        where id = $1`,
      [order.id, validatedBy.userId, validatedBy.name ?? null],
    );

    const departments = await tx.query<{ department_code: string }>(
      "select distinct department_code from orders.service_order_items where order_id = $1 order by department_code",
      [order.id],
    );
    const tickets: { ticketId: string; code: string; departmentCode: string }[] = [];
    for (const { department_code } of departments.rows) {
      const code = await nextNumber(
        tx,
        "orders",
        `ticket:${department_code}`,
        `T-${department_code}`,
      );
      const created = await tx.query<{ id: string }>(
        `insert into orders.department_tickets (order_id, code, department_code, released_by, released_by_name)
         values ($1, $2, $3, $4, $5) returning id`,
        [order.id, code, department_code, validatedBy.userId, validatedBy.name ?? null],
      );
      tickets.push({
        ticketId: (created.rows[0] as { id: string }).id,
        code,
        departmentCode: department_code,
      });
    }
    await recordStep(
      tx,
      order.id,
      "sent_to_departments",
      { id: ctx.user.id, name: ctx.user.name, role: "system" },
      {
        tickets: tickets.map((t) => ({
          code: t.code,
          departmentCode: t.departmentCode,
          payload: ticketPayload(t.code),
        })),
      },
    );
    await writeAudit(tx, ctx, {
      action: "order.release",
      entityType: "service_order",
      entityId: order.id,
      patientId: order.patient_id,
      detail: {
        number: order.number,
        releasedBy: validatedBy.userId,
        tickets: tickets.map((t) => t.code),
      },
    });
    await appendEvent(tx, ctx, {
      type: "ServiceOrderReleased",
      patientId: order.patient_id,
      payload: {
        orderId: order.id,
        orderNumber: order.number,
        releasedBy: {
          userId: validatedBy.userId,
          ...(validatedBy.name ? { name: validatedBy.name } : {}),
        },
        tickets,
      },
    });
  },
};

/**
 * Un avoir annule la demande tant qu'aucun service n'a commencé. Si un service a déjà commencé, la demande
 * est conservée et la trace signale le cas à traiter par la direction (prestation déjà rendue).
 */
export const cancelOnCredit: Consumer = {
  name: "orders.cancel-on-credit",
  types: ["InvoiceCredited"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "InvoiceCredited" || !event.payload.orderId) return;
    const { orderId, creditNoteNumber, reason } = event.payload;
    const found = await tx.query<LockedOrder>(
      "select id, number, patient_id, status from orders.service_orders where id = $1 for update",
      [orderId],
    );
    const order = found.rows[0];
    if (!order || order.status === "cancelled") return;
    const system = { id: ctx.user.id, name: ctx.user.name, role: "system" };
    const started = await tx.query(
      "select 1 from orders.department_tickets where order_id = $1 and status in ('in_progress', 'completed')",
      [order.id],
    );
    if (started.rowCount) {
      await recordStep(tx, order.id, "credit_note_after_service_started", system, {
        creditNoteNumber,
        reason,
      });
      return;
    }
    await tx.query(
      "update orders.department_tickets set status = 'cancelled' where order_id = $1",
      [order.id],
    );
    await tx.query("update orders.service_orders set status = 'cancelled' where id = $1", [
      order.id,
    ]);
    await recordStep(tx, order.id, "cancelled_by_credit_note", system, {
      creditNoteNumber,
      reason,
    });
    await writeAudit(tx, ctx, {
      action: "order.cancel",
      entityType: "service_order",
      entityId: order.id,
      patientId: order.patient_id,
      detail: { number: order.number, creditNoteNumber },
    });
  },
};

export const ordersConsumers: Consumer[] = [releaseOnPayment, cancelOnCredit];
