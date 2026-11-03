import type { Consumer } from "../../events/dispatcher.ts";
import { createRequestFromTicket } from "./service.ts";

/** Quand la caisse a libéré une demande, le ticket du laboratoire devient une demande d'analyses (F7-1). */
export const createLabRequests: Consumer = {
  name: "lab.create-requests",
  types: ["ServiceOrderReleased"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "ServiceOrderReleased") return;
    for (const ticket of event.payload.tickets) {
      if (ticket.departmentCode === "LAB") await createRequestFromTicket(tx, ctx, ticket.ticketId);
    }
  },
};

export const labConsumers: Consumer[] = [createLabRequests];
