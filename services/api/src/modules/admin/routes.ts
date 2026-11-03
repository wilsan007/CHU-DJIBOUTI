import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROLES } from "../../auth/permissions.ts";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import type { UserDirectory } from "./directory.ts";
import { changeRole, createUser, listUsers, setStatus } from "./service.ts";

const Role = z.enum(ROLES);
const Reason = z.object({ reason: z.string().trim().min(3).max(300) });
const Create = z.object({
  username: z.string().trim().min(3).max(60),
  email: z.string().email(),
  role: Role,
  temporaryPassword: z.string().min(12).max(100),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  db: Db,
  directory: UserDirectory | null,
): Promise<void> {
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;
  app.get(
    "/api/admin/users",
    { preHandler: requirePermission("admin:manage") },
    async (request) => ({
      users: await listUsers(db, (request.query as { status?: string }).status),
    }),
  );
  app.post(
    "/api/admin/users",
    { preHandler: requirePermission("admin:manage") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await createUser(db, contextOf(request), parseWith(Create, request.body), directory)),
  );
  app.put(
    "/api/admin/users/:id/role",
    { preHandler: requirePermission("admin:manage") },
    async (request) =>
      changeRole(
        db,
        contextOf(request),
        id(request),
        parseWith(z.object({ role: Role }), request.body).role,
        directory,
      ),
  );
  app.post(
    "/api/admin/users/:id/disable",
    { preHandler: requirePermission("admin:manage") },
    async (request) =>
      setStatus(
        db,
        contextOf(request),
        id(request),
        "disable",
        parseWith(Reason, request.body).reason,
        directory,
      ),
  );
  app.post(
    "/api/admin/users/:id/enable",
    { preHandler: requirePermission("admin:manage") },
    async (request) =>
      setStatus(db, contextOf(request), id(request), "enable", "réactivation", directory),
  );
}
