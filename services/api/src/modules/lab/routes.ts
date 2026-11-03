import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import {
  acknowledge,
  biologicalValidation,
  collectSpecimen,
  enterResult,
  importTests,
  ingestAnalyzer,
  listRequests,
  listSpecimens,
  listTests,
  myNotifications,
  patientResults,
  printLabel,
  printReport,
  qcSeries,
  qcStatusToday,
  receiveSpecimen,
  recordQc,
  rejectSpecimen,
  setAnalyzerMappings,
  setQcTarget,
  setRanges,
  technicalValidation,
  updateSettings,
} from "./service.ts";

const Collect = z.object({ patientScan: z.string().min(1), specimenType: z.string().min(1) });
const Scan = z.object({ scan: z.string().min(1) });
const Reject = z.object({ reason: z.string().trim().min(5).max(300) });
const Result = z
  .object({
    testCode: z.string().min(1),
    value: z.number().finite().optional(),
    text: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((r) => (r.value === undefined) !== (r.text === undefined), "value ou text, pas les deux");
const num = z.number().finite().optional();
const Ranges = z.object({
  ranges: z
    .array(
      z.object({
        sex: z.enum(["any", "male", "female"]).default("any"),
        ageMinDays: z.number().int().min(0).default(0),
        ageMaxDays: z.number().int().max(54750).default(54750),
        low: num,
        high: num,
        criticalLow: num,
        criticalHigh: num,
      }),
    )
    .max(40),
  validatedBy: z.string().trim().min(1),
  validatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const Message = z.object({ message: z.string().min(1).max(20000) });
const Mappings = z.object({
  mappings: z
    .array(z.object({ analyzerCode: z.string().min(1), testCode: z.string().min(1) }))
    .max(500),
});
const Settings = z.object({
  criticalAckMinutes: z.number().int().min(1).max(1440).optional(),
  escalationUser: z.string().max(100).optional(),
});
const QcTarget = z.object({
  testCode: z.string().min(1),
  level: z.string().min(1).max(20),
  mean: z.number().finite(),
  sd: z.number().positive(),
  setOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const QcRun = z.object({
  testCode: z.string().min(1),
  level: z.string().min(1).max(20),
  value: z.number().finite(),
});

export async function registerLabRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const p = (request: { params: unknown }, name: string) =>
    (request.params as Record<string, string>)[name] as string;

  app.post(
    "/api/lab/tests/import",
    { preHandler: requirePermission("lab:configure"), bodyLimit: 2 * 1024 * 1024 },
    async (request) => {
      if (typeof request.body !== "string") return importTests(db, contextOf(request), "");
      return importTests(db, contextOf(request), request.body);
    },
  );
  app.get("/api/lab/tests", { preHandler: requirePermission("lab:read") }, async () => ({
    tests: await listTests(db),
  }));
  app.put(
    "/api/lab/tests/:code/ranges",
    { preHandler: requirePermission("lab:configure") },
    async (request) =>
      setRanges(db, contextOf(request), p(request, "code"), parseWith(Ranges, request.body)),
  );

  app.get("/api/lab/requests", { preHandler: requirePermission("lab:write") }, async (request) => {
    const q = request.query as { status?: string; patientId?: string };
    return { requests: await listRequests(db, q) };
  });
  app.get(
    "/api/lab/specimens",
    { preHandler: requirePermission("lab:write") },
    async (request) => ({
      specimens: await listSpecimens(db, request.query as { status?: string }),
    }),
  );
  app.post(
    "/api/lab/requests/:id/collect",
    { preHandler: requirePermission("lab:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await collectSpecimen(
            db,
            contextOf(request),
            p(request, "id"),
            parseWith(Collect, request.body),
          ),
        ),
  );
  app.get(
    "/api/lab/specimens/:id/label",
    { preHandler: requirePermission("lab:write") },
    async (request) => printLabel(db, contextOf(request), p(request, "id")),
  );
  app.post(
    "/api/lab/specimens/receive",
    { preHandler: requirePermission("lab:write") },
    async (request) => receiveSpecimen(db, contextOf(request), parseWith(Scan, request.body).scan),
  );
  app.post(
    "/api/lab/specimens/:id/reject",
    { preHandler: requirePermission("lab:write") },
    async (request) =>
      rejectSpecimen(
        db,
        contextOf(request),
        p(request, "id"),
        parseWith(Reject, request.body).reason,
      ),
  );
  app.post(
    "/api/lab/specimens/:id/results",
    { preHandler: requirePermission("lab:write") },
    async (request, reply) => {
      const b = parseWith(Result, request.body);
      return reply.status(201).send(await enterResult(db, contextOf(request), p(request, "id"), b));
    },
  );
  app.post(
    "/api/lab/specimens/:id/validate-technical",
    { preHandler: requirePermission("lab:validate-tech") },
    async (request) => technicalValidation(db, contextOf(request), p(request, "id")),
  );
  app.post(
    "/api/lab/specimens/:id/validate-biological",
    { preHandler: requirePermission("lab:validate-bio") },
    async (request) => biologicalValidation(db, contextOf(request), p(request, "id")),
  );

  app.post(
    "/api/lab/analyzers/:analyzer/messages",
    { preHandler: requirePermission("lab:write") },
    async (request) =>
      ingestAnalyzer(
        db,
        contextOf(request),
        p(request, "analyzer"),
        parseWith(Message, request.body).message,
      ),
  );
  app.put(
    "/api/lab/analyzers/:analyzer/mappings",
    { preHandler: requirePermission("lab:configure") },
    async (request) =>
      setAnalyzerMappings(
        db,
        contextOf(request),
        p(request, "analyzer"),
        parseWith(Mappings, request.body).mappings,
      ),
  );

  // Le médecin voit les résultats validés ; le laboratoire voit aussi ceux en cours.
  app.get(
    "/api/lab/patients/:id/results",
    { preHandler: requirePermission("lab:read") },
    async (request) => ({
      results: await patientResults(db, contextOf(request), p(request, "id")),
    }),
  );
  app.get(
    "/api/lab/requests/:id/report",
    { preHandler: requirePermission("lab:read") },
    async (request) => printReport(db, contextOf(request), p(request, "id")),
  );

  app.get(
    "/api/lab/notifications",
    { preHandler: requirePermission("lab:read") },
    async (request) => ({
      notifications: await myNotifications(
        db,
        contextOf(request),
        (request.query as { open?: string }).open === "true",
      ),
    }),
  );
  app.post(
    "/api/lab/notifications/:id/acknowledge",
    { preHandler: requirePermission("lab:read") },
    async (request) => acknowledge(db, contextOf(request), Number(p(request, "id"))),
  );
  app.put(
    "/api/lab/settings",
    { preHandler: requirePermission("lab:configure") },
    async (request) => updateSettings(db, contextOf(request), parseWith(Settings, request.body)),
  );

  app.put(
    "/api/lab/qc/targets",
    { preHandler: requirePermission("lab:configure") },
    async (request) => setQcTarget(db, contextOf(request), parseWith(QcTarget, request.body)),
  );
  app.post(
    "/api/lab/qc/runs",
    { preHandler: requirePermission("lab:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await recordQc(db, contextOf(request), parseWith(QcRun, request.body))),
  );
  app.get("/api/lab/qc/status", { preHandler: requirePermission("lab:write") }, async () => ({
    tests: await qcStatusToday(db),
  }));
  app.get("/api/lab/qc/series", { preHandler: requirePermission("lab:write") }, async (request) => {
    const q = request.query as { testCode?: string; level?: string };
    return qcSeries(db, q.testCode ?? "", q.level ?? "");
  });
}
