import type { FastifyInstance } from "fastify";
import { renderCardHtml } from "./card-print.ts";
import { importPatients } from "./import.ts";
import { DomainError } from "../../errors.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import type { Db } from "../../db.ts";
import {
  CreatePatientSchema,
  CreateProvisionalSchema,
  LinkSchema,
  MergeSchema,
  PreferencesSchema,
  SearchSchema,
} from "./schemas.ts";
import {
  createPatient,
  createProvisionalPatient,
  getCard,
  getPatient,
  getPatientByCard,
  linkProvisional,
  mergePatients,
  searchPatients,
  setReminderPreference,
} from "./service.ts";

export async function registerIdentityRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // F1-1 et F1-3 : création, avec alerte de doublon (409 tant que l'utilisateur ne confirme pas).
  app.post(
    "/api/patients",
    { preHandler: requirePermission("patient:create") },
    async (request, reply) => {
      const input = parseWith(CreatePatientSchema, request.body);
      const { patient, created } = await createPatient(db, contextOf(request), input);
      return reply.status(created ? 201 : 200).send(patient);
    },
  );

  // F1-5 : patient inconnu en urgence.
  app.post(
    "/api/patients/provisional",
    { preHandler: requirePermission("patient:create") },
    async (request, reply) => {
      const input = parseWith(CreateProvisionalSchema, request.body);
      return reply.status(201).send(await createProvisionalPatient(db, contextOf(request), input));
    },
  );

  // F1-4 : fusion, administration seulement.
  app.post(
    "/api/patients/merge",
    { preHandler: requirePermission("patient:merge") },
    async (request) => {
      const input = parseWith(MergeSchema, request.body);
      return mergePatients(db, contextOf(request), input);
    },
  );

  // F1-2 : recherche tolérante aux fautes.
  app.get("/api/patients", { preHandler: requirePermission("patient:read") }, async (request) => {
    const { q, limit } = parseWith(SearchSchema, request.query);
    const hits = await searchPatients(db, q, limit);
    return { results: hits.map((h) => ({ ...h.patient, score: Math.round(h.score * 100) / 100 })) };
  });

  // Ouverture d'un dossier : tracée dans l'audit, suit les fusions.
  app.get(
    "/api/patients/:ref",
    { preHandler: requirePermission("patient:read") },
    async (request) => {
      const { ref } = request.params as { ref: string };
      return getPatient(db, contextOf(request), ref);
    },
  );

  // F1-6 : contenu du QR code de la carte (identifiant et clé de contrôle, rien d'autre).
  app.get(
    "/api/patients/:ref/card",
    { preHandler: requirePermission("patient:read") },
    async (request) => {
      const { ref } = request.params as { ref: string };
      return getCard(await getPatient(db, contextOf(request), ref));
    },
  );

  // Reprise des patients de l'ancien registre : essai par défaut, `?apply=true` pour écrire. Administrateur seulement.
  app.post(
    "/api/patients/import",
    { preHandler: requirePermission("patient:import"), bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      if (typeof request.body !== "string")
        throw new DomainError(
          "csv_required",
          "Envoyez le fichier CSV avec l'en-tête Content-Type: text/csv.",
          400,
        );
      const apply = (request.query as { apply?: string }).apply === "true";
      return importPatients(db, contextOf(request), request.body, { apply });
    },
  );

  // Carte imprimable avec son QR (le QR ne contient que l'identifiant et la clé de contrôle).
  app.get(
    "/api/patients/:ref/card/print",
    { preHandler: requirePermission("patient:read") },
    async (request) => {
      const { ref } = request.params as { ref: string };
      const patient = await getPatient(db, contextOf(request), ref);
      return { identifier: patient.identifier, html: renderCardHtml(patient) };
    },
  );

  // F1-6 : ouverture du dossier à partir du code lu.
  app.get(
    "/api/cards/:payload",
    { preHandler: requirePermission("patient:read") },
    async (request) => {
      const { payload } = request.params as { payload: string };
      return getPatientByCard(db, contextOf(request), payload);
    },
  );

  // F1-5 : rattachement d'un dossier provisoire à un vrai dossier.
  app.post(
    "/api/patients/:ref/link",
    { preHandler: requirePermission("patient:link-provisional") },
    async (request) => {
      const { ref } = request.params as { ref: string };
      const { patientId } = parseWith(LinkSchema, request.body);
      return linkProvisional(db, contextOf(request), ref, patientId);
    },
  );

  // F3-4 : le patient peut refuser les rappels.
  app.put(
    "/api/patients/:ref/preferences",
    { preHandler: requirePermission("patient:create") },
    async (request) => {
      const { ref } = request.params as { ref: string };
      const { reminderOptOut } = parseWith(PreferencesSchema, request.body);
      return setReminderPreference(db, contextOf(request), ref, reminderOptOut);
    },
  );
}
