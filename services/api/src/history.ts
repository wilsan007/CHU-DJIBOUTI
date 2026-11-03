import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit, type RequestContext } from "./audit/audit.ts";
import { withTransaction, type Db } from "./db.ts";
import { contextOf, parseWith, requirePermission } from "./http.ts";
import { consultationSummaries } from "./modules/clinical/service.ts";
import { relatedPatientIds } from "./modules/identity/interface.ts";
import { getPatient } from "./modules/identity/service.ts";
import { listOrders } from "./modules/orders/service.ts";
import { prescriptionSummaries } from "./modules/prescriptions/service.ts";

/**
 * Historique chronologique d'un patient (F4-5) : consultations, ordonnances, demandes de prestations,
 * sur une seule ligne de temps filtrable. Chaque module fournit ses éléments par son interface.
 */

export type HistoryKind = "consultation" | "prescription" | "order";

export interface HistoryItem {
  kind: HistoryKind;
  id: string;
  date: string;
  title: string;
  status: string;
  detail: Record<string, unknown>;
}

export async function patientHistory(
  db: Db,
  ctx: RequestContext,
  ref: string,
  kinds: readonly HistoryKind[],
): Promise<HistoryItem[]> {
  const patient = await getPatient(db, ctx, ref); // suit les fusions et trace l'ouverture du dossier
  return withTransaction(db, async (tx) => {
    const ids = await relatedPatientIds(tx, patient.id);
    const items: HistoryItem[] = [];
    if (kinds.includes("consultation")) {
      for (const c of await consultationSummaries(tx, ids)) {
        items.push({
          kind: "consultation",
          id: c.id,
          date: c.date,
          title: c.reason || "Consultation",
          status: c.status,
          detail: { practitioner: c.practitionerName, diagnoses: c.diagnosisCodes },
        });
      }
    }
    if (kinds.includes("prescription")) {
      for (const p of await prescriptionSummaries(tx, ids)) {
        items.push({
          kind: "prescription",
          id: p.id,
          date: p.signedAt,
          title: `Ordonnance ${p.number}`,
          status: p.status,
          detail: { lines: p.lines, supersedes: p.supersedes },
        });
      }
    }
    if (kinds.includes("order")) {
      for (const o of await listOrders(tx, { patientId: patient.id, limit: 200 })) {
        items.push({
          kind: "order",
          id: o.id,
          date: o.placedAt,
          title: `Demande ${o.number}`,
          status: o.status,
          detail: {},
        });
      }
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    await writeAudit(tx, ctx, {
      action: "history.read",
      entityType: "patient",
      entityId: patient.id,
      patientId: patient.id,
      detail: { kinds },
    });
    return items;
  });
}

const Kinds = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(",") : ["consultation", "prescription", "order"]))
  .pipe(z.array(z.enum(["consultation", "prescription", "order"])).min(1));

export async function registerHistoryRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get(
    "/api/patients/:id/history",
    { preHandler: requirePermission("clinical:read") },
    async (request) => {
      const { kinds } = parseWith(z.object({ kinds: Kinds }), request.query);
      return {
        items: await patientHistory(
          db,
          contextOf(request),
          (request.params as { id: string }).id,
          kinds,
        ),
      };
    },
  );
}
