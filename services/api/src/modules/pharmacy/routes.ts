import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import { dispense, dispensationStatus } from "./service.ts";

const Dispense = z.object({
  prescriptionId: z.string().uuid(),
  depot: z.string().min(1),
  lines: z
    .array(z.object({ lineNo: z.number().int().positive(), quantity: z.number().int().positive() }))
    .min(1)
    .optional(),
});

/** Pharmacie : délivrance sur ordonnance. Le stock (lots, dépôts, commandes, inventaire) est dans le module Stocks. */
export async function registerPharmacyRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.post(
    "/api/pharmacy/dispensations",
    { preHandler: requirePermission("pharmacy:dispense") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await dispense(db, contextOf(request), parseWith(Dispense, request.body))),
  );
  app.get(
    "/api/pharmacy/prescriptions/:id",
    { preHandler: requirePermission("pharmacy:dispense") },
    async (request) =>
      dispensationStatus(db, contextOf(request), (request.params as { id: string }).id),
  );
}
