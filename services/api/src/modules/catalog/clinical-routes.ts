import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { DomainError } from "../../errors.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import {
  importDiagnoses,
  importDrugs,
  saveInteraction,
  saveStandardDosage,
  searchDiagnoses,
  searchDrugs,
  standardDosages,
  vitalLimits,
} from "./clinical.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Search = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(15),
});
const DosageSchema = z.object({
  dose: z.number().positive().max(10000),
  perDay: z.number().int().min(1).max(12),
  days: z.number().int().min(1).max(365),
  route: z.enum(["oral", "injectable", "cutaneous", "other"]),
  validatedBy: z.string().trim().min(2).max(100),
  validatedOn: day,
});
const InteractionSchema = z.object({
  classA: z.string().trim().min(1).max(40),
  classB: z.string().trim().min(1).max(40),
  messageFr: z.string().trim().min(3).max(300),
  messageAr: z.string().trim().min(3).max(300),
  validatedBy: z.string().trim().min(2).max(100),
  validatedOn: day,
});

export async function registerClinicalCatalogRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const csv = (body: unknown): string => {
    if (typeof body !== "string") {
      throw new DomainError(
        "invalid_body",
        "Envoyez le fichier CSV avec l'en-tête Content-Type: text/csv.",
        415,
      );
    }
    return body;
  };

  // F4-3 : auto-complétion CIM-10 ; F5-1 : recherche de médicaments par DCI.
  app.get(
    "/api/catalog/diagnoses",
    { preHandler: requirePermission("catalog:read") },
    async (request) => {
      const { q, limit } = parseWith(Search, request.query);
      return { diagnoses: await searchDiagnoses(db, q, limit) };
    },
  );
  app.get(
    "/api/catalog/drugs",
    { preHandler: requirePermission("catalog:read") },
    async (request) => {
      const { q, limit } = parseWith(Search, request.query);
      return { drugs: await searchDrugs(db, q, limit) };
    },
  );
  app.get(
    "/api/catalog/drugs/:code/standard-dosages",
    { preHandler: requirePermission("catalog:read") },
    async (request) => ({
      dosages: await standardDosages(db, (request.params as { code: string }).code),
    }),
  );
  app.get(
    "/api/catalog/vital-limits",
    { preHandler: requirePermission("catalog:read") },
    async () => ({
      limits: [...(await vitalLimits(db)).values()],
    }),
  );

  app.post(
    "/api/catalog/diagnoses/import",
    { preHandler: requirePermission("catalog:manage") },
    (request) => importDiagnoses(db, contextOf(request), csv(request.body)),
  );
  app.post(
    "/api/catalog/drugs/import",
    { preHandler: requirePermission("catalog:manage") },
    (request) => importDrugs(db, contextOf(request), csv(request.body)),
  );
  app.post(
    "/api/catalog/drugs/:code/standard-dosages",
    { preHandler: requirePermission("catalog:manage") },
    async (request, reply) => {
      await saveStandardDosage(
        db,
        contextOf(request),
        (request.params as { code: string }).code,
        parseWith(DosageSchema, request.body),
      );
      return reply.status(201).send({ ok: true });
    },
  );
  app.put(
    "/api/catalog/interactions",
    { preHandler: requirePermission("catalog:manage") },
    async (request) => {
      await saveInteraction(db, contextOf(request), parseWith(InteractionSchema, request.body));
      return { ok: true };
    },
  );
}
