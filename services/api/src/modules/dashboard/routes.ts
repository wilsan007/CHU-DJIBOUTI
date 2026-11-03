import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import { dashboard } from "./service.ts";

const Query = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function registerDashboardRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/dashboard", { preHandler: requirePermission("dashboard:read") }, async (request) =>
    dashboard(db, contextOf(request), parseWith(Query, request.query).date),
  );
}
