import type { Consumer } from "../../events/dispatcher.ts";
import { ticketContext } from "../orders/service.ts";
import { consumeForAct } from "./service.ts";

/**
 * Quand un service a terminé les prestations d'un ticket (analyse, examen d'imagerie, acte d'hospitalisation ou de bloc),
 * la recette de chaque acte est prélevée dans le dépôt du service : réactifs, seringues, produit de contraste, kit...
 * Le manque éventuel est enregistré à régulariser, il ne bloque jamais le service déjà rendu.
 */
export const consumeOnServiceCompleted: Consumer = {
  name: "stock.consume-on-service-completed",
  types: ["DepartmentServiceCompleted"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "DepartmentServiceCompleted") return;
    const c = await ticketContext(tx, event.payload.ticketId);
    for (const item of c.items) {
      await consumeForAct(tx, ctx, {
        actCode: item.actCode,
        times: item.quantity,
        department: c.ticket.departmentCode,
        patientId: event.patientId,
        refType: "ticket",
        refId: c.ticket.code,
      });
    }
  },
};

export const stockConsumers: Consumer[] = [consumeOnServiceCompleted];
