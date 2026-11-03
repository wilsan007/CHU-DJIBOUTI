import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import {
  addImage,
  getImage,
  getRequest,
  listRequests,
  perform,
  report,
  schedule,
} from "./service.ts";

const Schedule = z.object({ scheduledFor: z.string().datetime({ offset: true }) });
const Image = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.string().max(100),
  dataBase64: z.string().min(1),
});
const Report = z.object({
  findings: z.string().trim().min(3).max(10000),
  conclusion: z.string().trim().min(3).max(3000),
});

export async function registerImagingRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;
  app.get(
    "/api/imaging/requests",
    { preHandler: requirePermission("imaging:read") },
    async (request) => {
      const q = request.query as { status?: string; patientId?: string };
      return { requests: await listRequests(db, q) };
    },
  );
  app.get(
    "/api/imaging/requests/:id",
    { preHandler: requirePermission("imaging:read") },
    async (request) => getRequest(db, contextOf(request), id(request)),
  );
  app.post(
    "/api/imaging/requests/:id/schedule",
    { preHandler: requirePermission("imaging:write") },
    async (request) =>
      schedule(db, contextOf(request), id(request), parseWith(Schedule, request.body).scheduledFor),
  );
  app.post(
    "/api/imaging/requests/:id/perform",
    { preHandler: requirePermission("imaging:write") },
    async (request) => perform(db, contextOf(request), id(request)),
  );
  app.post(
    "/api/imaging/requests/:id/images",
    { preHandler: requirePermission("imaging:write"), bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) =>
      reply
        .status(201)
        .send(await addImage(db, contextOf(request), id(request), parseWith(Image, request.body))),
  );
  app.post(
    "/api/imaging/requests/:id/report",
    { preHandler: requirePermission("imaging:write") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await report(db, contextOf(request), id(request), parseWith(Report, request.body))),
  );
  app.get(
    "/api/imaging/images/:id",
    { preHandler: requirePermission("imaging:read") },
    async (request, reply) => {
      const img = await getImage(db, contextOf(request), id(request));
      void reply.header("content-type", img.mime);
      void reply.header(
        "content-disposition",
        `inline; filename="${img.filename.replace(/[^\w.-]/g, "_")}"`,
      );
      return reply.send(img.data);
    },
  );
}
