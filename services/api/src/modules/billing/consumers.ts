import type { Consumer } from "../../events/dispatcher.ts";
import { getActs, requirePayer } from "../catalog/service.ts";
import { getEncounter, issueInvoice } from "./service.ts";

/**
 * Dès qu'un médecin demande des prestations, la facture correspondante est émise et attend la caisse.
 * Les prix sont ceux du moment de la demande (reçus dans l'événement), pas ceux du catalogue d'aujourd'hui.
 */
export const invoiceForOrder: Consumer = {
  name: "billing.invoice-for-order",
  types: ["ServiceOrderPlaced"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "ServiceOrderPlaced" || !event.patientId) return;
    const { orderId, orderNumber, encounterId, items } = event.payload;
    const existing = await tx.query(
      "select 1 from billing.invoices where order_id = $1 and kind = 'invoice'",
      [orderId],
    );
    if (existing.rowCount) return;
    const encounter = await getEncounter(tx, encounterId);
    const payer = await requirePayer(tx, encounter.payerCode);
    const acts = await getActs(
      tx,
      items.map((i) => i.actCode),
    );
    const lines = items.map((i) => {
      const act = acts.get(i.actCode);
      if (!act) throw new Error(`Acte ${i.actCode} introuvable au catalogue`);
      return { act, unitPrice: i.unitPrice, quantity: i.quantity };
    });
    await issueInvoice(tx, ctx, {
      encounterId,
      orderId,
      orderNumber,
      patientId: event.patientId,
      payer,
      lines,
    });
  },
};

export const billingConsumers: Consumer[] = [invoiceForOrder];
