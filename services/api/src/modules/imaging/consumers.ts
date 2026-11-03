import type { Consumer } from "../../events/dispatcher.ts";
import { createRequestsFromTicket } from "./service.ts";

/** Quand la caisse a libéré une demande, le ticket d'imagerie devient des examens à programmer. */
export const createImagingRequests: Consumer = {
  name: "imaging.create-requests",
  types: ["ServiceOrderReleased"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "ServiceOrderReleased") return;
    for (const ticket of event.payload.tickets) {
      if (ticket.departmentCode === "IMG") await createRequestsFromTicket(tx, ctx, ticket.ticketId);
    }
  },
};

export const imagingConsumers: Consumer[] = [createImagingRequests];
