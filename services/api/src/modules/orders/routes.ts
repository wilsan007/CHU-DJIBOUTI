import type { FastifyInstance } from "fastify";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import type { Db } from "../../db.ts";
import { OrderListSchema, PlaceOrderSchema, TicketListSchema } from "./schemas.ts";
import {
  completeTicket,
  getOrder,
  getTrace,
  getVoucher,
  listOrders,
  listTickets,
  placeOrder,
  startTicket,
} from "./service.ts";

export async function registerOrderRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Le médecin demande des prestations : la demande attend le paiement à la caisse.
  app.post(
    "/api/service-orders",
    { preHandler: requirePermission("order:place") },
    async (request, reply) => {
      const order = await placeOrder(
        db,
        contextOf(request),
        parseWith(PlaceOrderSchema, request.body),
      );
      return reply.status(201).send(order);
    },
  );

  app.get(
    "/api/service-orders",
    { preHandler: requirePermission("order:read") },
    async (request) => {
      const f = parseWith(OrderListSchema, request.query);
      return {
        orders: await listOrders(db, {
          limit: f.limit,
          ...(f.patientId ? { patientId: f.patientId } : {}),
          ...(f.status ? { status: f.status } : {}),
        }),
      };
    },
  );

  app.get(
    "/api/service-orders/:id",
    { preHandler: requirePermission("order:read") },
    async (request) => getOrder(db, (request.params as { id: string }).id),
  );

  // Traçabilité : qui a demandé, qui a validé à la caisse, envoi au service, qui a exécuté.
  app.get(
    "/api/service-orders/:id/trace",
    { preHandler: requirePermission("order:read") },
    async (request) => getTrace(db, (request.params as { id: string }).id),
  );

  // Le document remis au patient par la caisse, seulement après paiement.
  app.get(
    "/api/service-orders/:id/voucher",
    { preHandler: requirePermission("voucher:print") },
    async (request) => getVoucher(db, contextOf(request), (request.params as { id: string }).id),
  );

  // Côté service : tickets reçus, démarrage et fin de la prestation.
  app.get(
    "/api/department-tickets",
    { preHandler: requirePermission("ticket:work") },
    async (request) => {
      const f = parseWith(TicketListSchema, request.query);
      return {
        tickets: await listTickets(db, contextOf(request), {
          department: f.department,
          ...(f.status ? { status: f.status } : {}),
        }),
      };
    },
  );
  app.post(
    "/api/department-tickets/:id/start",
    { preHandler: requirePermission("ticket:work") },
    async (request) => startTicket(db, contextOf(request), (request.params as { id: string }).id),
  );
  app.post(
    "/api/department-tickets/:id/complete",
    { preHandler: requirePermission("ticket:work") },
    async (request) =>
      completeTicket(db, contextOf(request), (request.params as { id: string }).id),
  );
}
