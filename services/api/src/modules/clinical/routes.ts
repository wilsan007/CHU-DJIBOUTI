import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import {
  addAllergy,
  addAttachment,
  addDiagnosis,
  closeConsultation,
  consultationOfEncounter,
  getAttachment,
  getConsultation,
  getReport,
  listTemplates,
  patientBanner,
  recordVital,
  removeDiagnosis,
  saveConsultation,
  saveTemplate,
  startConsultation,
  voidAllergy,
} from "./service.ts";

const Start = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid(),
  templateId: z.number().int().positive().optional(),
});
const Save = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().max(5000).optional(),
  exam: z.string().max(5000).optional(),
  notes: z.string().max(10000).optional(),
});
const Vital = z.object({
  kind: z.enum(["weight", "height", "systolic", "diastolic", "temperature", "pulse", "spo2"]),
  value: z.number().finite(),
  confirm: z.boolean().optional(),
});
const Diagnosis = z.object({
  code: z.string().trim().min(1).max(20),
  primary: z.boolean().optional(),
});
const Attachment = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.string().max(100),
  dataBase64: z.string().min(1),
});
const Allergy = z.object({
  substanceClass: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(200),
  severity: z.enum(["mild", "moderate", "severe", "unknown"]).default("unknown"),
});
const Template = z.object({
  specialty: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  reasonText: z.string().max(5000).default(""),
  examText: z.string().max(5000).default(""),
});

export async function registerClinicalRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;

  // Les pièces jointes arrivent en JSON (base64) ; la limite de la requête couvre la taille maximale.
  app.post(
    "/api/consultations",
    { preHandler: requirePermission("clinical:write") },
    async (request, reply) => {
      const b = parseWith(Start, request.body);
      return reply.status(201).send(
        await startConsultation(db, contextOf(request), {
          patientId: b.patientId,
          encounterId: b.encounterId,
          templateId: b.templateId,
        }),
      );
    },
  );
  app.get(
    "/api/encounters/:id/consultation",
    { preHandler: requirePermission("clinical:read") },
    async (request, reply) => {
      const found = await consultationOfEncounter(db, contextOf(request), id(request));
      // 204 : l'admission existe mais aucune consultation n'est commencée (le panneau propose de la commencer).
      return found ?? reply.status(204).send();
    },
  );
  app.get(
    "/api/consultations/:id",
    { preHandler: requirePermission("clinical:read") },
    async (request) => getConsultation(db, contextOf(request), id(request)),
  );
  app.put(
    "/api/consultations/:id",
    { preHandler: requirePermission("clinical:write") },
    async (request) =>
      saveConsultation(db, contextOf(request), id(request), parseWith(Save, request.body)),
  );
  app.post(
    "/api/consultations/:id/vitals",
    { preHandler: requirePermission("clinical:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await recordVital(db, contextOf(request), id(request), parseWith(Vital, request.body)),
        ),
  );
  app.post(
    "/api/consultations/:id/diagnoses",
    { preHandler: requirePermission("clinical:write") },
    async (request, reply) => {
      const b = parseWith(Diagnosis, request.body);
      return reply
        .status(201)
        .send({ diagnoses: await addDiagnosis(db, contextOf(request), id(request), b) });
    },
  );
  app.delete(
    "/api/consultations/:id/diagnoses/:code",
    { preHandler: requirePermission("clinical:write") },
    async (request) => ({
      diagnoses: await removeDiagnosis(
        db,
        contextOf(request),
        id(request),
        (request.params as { code: string }).code,
      ),
    }),
  );
  app.post(
    "/api/consultations/:id/attachments",
    { preHandler: requirePermission("clinical:write"), bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await addAttachment(
            db,
            contextOf(request),
            id(request),
            parseWith(Attachment, request.body),
          ),
        ),
  );
  app.get(
    "/api/attachments/:id",
    { preHandler: requirePermission("clinical:read") },
    async (request, reply) => {
      const file = await getAttachment(db, contextOf(request), id(request));
      void reply.header("content-type", file.mime);
      void reply.header(
        "content-disposition",
        `inline; filename="${file.filename.replace(/[^\w.-]/g, "_")}"`,
      );
      return reply.send(file.data);
    },
  );
  app.post(
    "/api/consultations/:id/close",
    { preHandler: requirePermission("clinical:write") },
    async (request) => closeConsultation(db, contextOf(request), id(request)),
  );
  app.get(
    "/api/consultations/:id/report",
    { preHandler: requirePermission("clinical:read") },
    async (request) => getReport(db, contextOf(request), id(request)),
  );

  // F4-1 : bandeau patient (identité, âge, allergies). Les allergies ne sont montrées qu'aux rôles cliniques et à la pharmacie.
  app.get(
    "/api/patients/:id/banner",
    { preHandler: requirePermission("patient:read") },
    async (request) => patientBanner(db, contextOf(request), id(request)),
  );
  app.post(
    "/api/patients/:id/allergies",
    { preHandler: requirePermission("clinical:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await addAllergy(db, contextOf(request), id(request), parseWith(Allergy, request.body)),
        ),
  );
  app.post(
    "/api/allergies/:id/void",
    { preHandler: requirePermission("clinical:write") },
    async (request) => {
      await voidAllergy(db, contextOf(request), id(request));
      return { ok: true };
    },
  );

  // F4-4 : modèles par spécialité.
  app.get(
    "/api/clinical/templates",
    { preHandler: requirePermission("clinical:read") },
    async (request) => ({
      templates: await listTemplates(db, (request.query as { specialty?: string }).specialty),
    }),
  );
  app.put(
    "/api/clinical/templates",
    { preHandler: requirePermission("catalog:manage") },
    async (request) => ({
      id: await saveTemplate(db, contextOf(request), parseWith(Template, request.body)),
    }),
  );
}
