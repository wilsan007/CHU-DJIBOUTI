import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requireAnyPermission, requirePermission } from "../../http.ts";
import {
  addCharge,
  admitToBed,
  createBed,
  createStay,
  exitStay,
  getStay,
  listBeds,
  listStays,
  orderDischarge,
  placeExtraOrder,
} from "./service.ts";

const Items = z
  .array(
    z.object({
      actCode: z.string().trim().min(1).max(40),
      quantity: z.number().int().min(1).max(50),
    }),
  )
  .min(1)
  .max(20);
const Create = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid(),
  items: Items,
  note: z.string().trim().max(500).optional(),
});
const Admit = z.object({ bedCode: z.string().min(1).max(30) });
const Extra = z.object({ items: Items, note: z.string().trim().max(500).optional() });
const Charge = z.object({
  actCode: z.string().trim().min(1).max(40),
  quantity: z.number().int().min(1).max(100),
  note: z.string().trim().max(300).optional(),
});
const Exit = z.object({ unpaidReason: z.string().trim().max(300).optional() });
const Bed = z.object({
  code: z.string().trim().min(1).max(30),
  ward: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(100),
});

export async function registerHospitalizationRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;
  app.get("/api/beds", { preHandler: requirePermission("stay:read") }, async () => ({
    beds: await listBeds(db),
  }));
  app.post("/api/beds", { preHandler: requirePermission("admin:manage") }, async (request, reply) =>
    reply.status(201).send(await createBed(db, contextOf(request), parseWith(Bed, request.body))),
  );
  app.post("/api/stays", { preHandler: requirePermission("stay:manage") }, async (request, reply) =>
    reply
      .status(201)
      .send(await createStay(db, contextOf(request), parseWith(Create, request.body))),
  );
  app.get("/api/stays", { preHandler: requirePermission("stay:read") }, async (request) => ({
    stays: await listStays(db, (request.query as { status?: string }).status),
  }));
  app.get("/api/stays/:id", { preHandler: requirePermission("stay:read") }, async (request) =>
    getStay(db, contextOf(request), id(request)),
  );
  app.post(
    "/api/stays/:id/admit",
    { preHandler: requirePermission("stay:admit") },
    async (request) =>
      admitToBed(db, contextOf(request), id(request), parseWith(Admit, request.body).bedCode),
  );
  app.post(
    "/api/stays/:id/orders",
    { preHandler: requirePermission("stay:manage") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await placeExtraOrder(
            db,
            contextOf(request),
            id(request),
            parseWith(Extra, request.body),
          ),
        ),
  );
  app.post(
    "/api/stays/:id/charges",
    { preHandler: requirePermission("stay:manage") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await addCharge(db, contextOf(request), id(request), parseWith(Charge, request.body)),
        ),
  );
  app.post(
    "/api/stays/:id/discharge",
    { preHandler: requirePermission("stay:discharge") },
    async (request) => orderDischarge(db, contextOf(request), id(request)),
  );
  app.post(
    "/api/stays/:id/exit",
    { preHandler: requireAnyPermission("stay:admit", "stay:discharge", "stay:exit-unpaid") },
    async (request) =>
      exitStay(
        db,
        contextOf(request),
        id(request),
        parseWith(Exit, request.body ?? {}).unpaidReason,
      ),
  );
}
