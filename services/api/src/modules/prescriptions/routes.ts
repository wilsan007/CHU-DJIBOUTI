import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import {
  createPrescription,
  getPrescription,
  listPrescriptions,
  previewAlerts,
  printPrescription,
  renewPrescription,
  revisePrescription,
  verifyPrescription,
} from "./service.ts";

const Line = z.object({
  drugCode: z.string().trim().min(1).max(40),
  dose: z.number().positive().max(10000),
  perDay: z.number().int().min(1).max(12),
  days: z.number().int().min(1).max(365),
  route: z.enum(["oral", "injectable", "cutaneous", "other"]),
});
const Override = z.object({
  key: z.string().min(1).max(200),
  justification: z.string().trim().min(5).max(500),
});
const Create = z.object({
  patientId: z.string().uuid(),
  consultationId: z.string().uuid(),
  lines: z.array(Line).min(1).max(20),
  overrides: z.array(Override).max(40).default([]),
});
const Check = z.object({ patientId: z.string().uuid(), lines: z.array(Line).min(1).max(20) });
const Revise = z.object({
  lines: z.array(Line).min(1).max(20),
  overrides: z.array(Override).max(40).default([]),
  reason: z.string().trim().min(3).max(300),
});
const Renew = z.object({
  consultationId: z.string().uuid(),
  overrides: z.array(Override).max(40).default([]),
});
const List = z.object({ status: z.string().optional(), patientId: z.string().uuid().optional() });

export async function registerPrescriptionRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;

  // Alertes affichées pendant la saisie, sans rien enregistrer.
  app.post(
    "/api/prescriptions/check",
    { preHandler: requirePermission("prescription:write") },
    async (request) => ({
      alerts: await previewAlerts(db, parseWith(Check, request.body)),
    }),
  );

  // F5-2, F5-3 : signature, avec justification écrite de chaque alerte.
  app.post(
    "/api/prescriptions",
    { preHandler: requirePermission("prescription:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await createPrescription(db, contextOf(request), parseWith(Create, request.body))),
  );

  // F5-5 : la pharmacie voit les ordonnances à servir.
  app.get(
    "/api/prescriptions",
    { preHandler: requirePermission("prescription:read") },
    async (request) => {
      const q = parseWith(List, request.query);
      return { prescriptions: await listPrescriptions(db, q) };
    },
  );
  app.get(
    "/api/prescriptions/verify/:payload",
    { preHandler: requirePermission("prescription:read") },
    async (request) =>
      verifyPrescription(db, contextOf(request), (request.params as { payload: string }).payload),
  );
  app.get(
    "/api/prescriptions/:id",
    { preHandler: requirePermission("prescription:read") },
    async (request) => getPrescription(db, contextOf(request), id(request)),
  );
  app.get(
    "/api/prescriptions/:id/print",
    { preHandler: requirePermission("prescription:read") },
    async (request) => printPrescription(db, contextOf(request), id(request)),
  );

  // F5-6 : révision et renouvellement.
  app.post(
    "/api/prescriptions/:id/revise",
    { preHandler: requirePermission("prescription:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await revisePrescription(
            db,
            contextOf(request),
            id(request),
            parseWith(Revise, request.body),
          ),
        ),
  );
  app.post(
    "/api/prescriptions/:id/renew",
    { preHandler: requirePermission("prescription:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await renewPrescription(
            db,
            contextOf(request),
            id(request),
            parseWith(Renew, request.body),
          ),
        ),
  );
}
