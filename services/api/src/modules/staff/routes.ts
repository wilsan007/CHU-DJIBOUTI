import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { DomainError } from "../../errors.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import { ROLES, type Role } from "../../auth/permissions.ts";
import type { UserDirectory } from "../admin/directory.ts";
import { createUser as createAccount } from "../admin/service.ts";
import {
  addQualification,
  DEFAULT_ROLE,
  CATEGORIES,
  cancelLeave,
  createMember,
  createShift,
  decideLeave,
  deleteShift,
  getMember,
  linkAccount,
  listLeaves,
  listMembers,
  listShifts,
  myRecord,
  onDuty,
  requestLeave,
  revokeQualification,
  unlinkAccount,
  setStatus,
  updateMember,
} from "./service.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });
const Member = z.object({
  givenName: z.string().trim().min(1).max(100),
  familyName: z.string().trim().min(1).max(100),
  sex: z.enum(["female", "male"]).optional(),
  birthDate: date.optional(),
  phone: z.string().trim().min(3).max(30).optional(),
  email: z.string().email().optional(),
  category: z.enum(CATEGORIES),
  jobTitle: z.string().trim().min(2).max(120),
  departmentCode: z.string().trim().min(1).max(20).optional(),
  hiredOn: date,
});
/** Création du compte de connexion en même temps que la fiche (facultatif ; le rôle par défaut vient de la catégorie). */
const NewMember = Member.extend({
  account: z
    .object({
      username: z.string().trim().min(3).max(60),
      email: z.string().email(),
      role: z.enum(ROLES).optional(),
      temporaryPassword: z.string().min(12).max(100),
    })
    .optional(),
});
const MemberUpdate = Member.partial();
const Status = z.object({
  status: z.enum(["active", "on_leave", "suspended", "left"]),
  effectiveOn: date,
  reason: z.string().trim().min(3).max(300),
});
const Link = z.object({ userId: z.string().trim().min(1).max(100) });
const Qualification = z.object({
  kind: z.enum(["diploma", "certification"]),
  title: z.string().trim().min(2).max(200),
  number: z.string().trim().max(60).optional(),
  issuer: z.string().trim().max(120).optional(),
  issuedOn: date.optional(),
  expiresOn: date.optional(),
});
const Shift = z.object({
  memberId: z.string().uuid(),
  departmentCode: z.string().trim().min(1).max(20),
  kind: z.enum(["day", "night", "on_call"]),
  startsAt: instant,
  endsAt: instant,
});
const Leave = z.object({
  kind: z.enum(["annual", "sick", "maternity", "unpaid", "other"]),
  startsOn: date,
  endsOn: date,
  reason: z.string().trim().max(300).optional(),
});
const Decide = z.object({ approve: z.boolean(), note: z.string().trim().min(3).max(300) });

export async function registerStaffRoutes(
  app: FastifyInstance,
  db: Db,
  directory: UserDirectory | null,
): Promise<void> {
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;
  const manage = requirePermission("staff:manage");
  const syncAccount = async (
    userId: string | null,
    account: "disabled" | "enabled" | null,
  ): Promise<boolean | null> => {
    if (!directory || !userId || !account) return null;
    try {
      await directory.setEnabled(userId, account === "enabled");
      return true;
    } catch {
      return false;
    }
  };

  // Self-service : chaque agent consulte sa fiche, ses gardes et gère ses demandes de congé.
  app.get("/api/staff/me", async (request) => myRecord(db, contextOf(request)));
  app.post("/api/staff/me/leaves", async (request, reply) =>
    reply
      .status(201)
      .send(await requestLeave(db, contextOf(request), parseWith(Leave, request.body))),
  );
  app.post("/api/staff/me/leaves/:id/cancel", async (request) =>
    cancelLeave(db, contextOf(request), id(request)),
  );

  app.post("/api/staff/qualifications/:id/revoke", { preHandler: manage }, async (request) =>
    revokeQualification(
      db,
      contextOf(request),
      Number(id(request)),
      parseWith(z.object({ reason: z.string().trim().min(3).max(300) }), request.body).reason,
    ),
  );

  app.get(
    "/api/staff/shifts",
    { preHandler: requirePermission("staff:roster-read") },
    async (request) => {
      const q = parseWith(
        z.object({
          from: instant,
          to: instant,
          department: z.string().optional(),
          memberId: z.string().uuid().optional(),
        }),
        request.query,
      );
      return { shifts: await listShifts(db, q) };
    },
  );
  app.get(
    "/api/staff/on-duty",
    { preHandler: requirePermission("staff:roster-read") },
    async (request) => ({
      onDuty: await onDuty(db, (request.query as { department?: string }).department),
    }),
  );
  app.post(
    "/api/staff/shifts",
    { preHandler: requirePermission("staff:roster") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await createShift(db, contextOf(request), parseWith(Shift, request.body))),
  );
  app.delete(
    "/api/staff/shifts/:id",
    { preHandler: requirePermission("staff:roster") },
    async (request) => deleteShift(db, contextOf(request), id(request)),
  );

  app.get("/api/staff/leaves", { preHandler: manage }, async (request) => ({
    leaves: await listLeaves(db, request.query as { status?: string; memberId?: string }),
  }));
  app.post(
    "/api/staff/leaves/:id/decide",
    { preHandler: requirePermission("leave:approve") },
    async (request) =>
      decideLeave(db, contextOf(request), id(request), parseWith(Decide, request.body)),
  );

  app.get("/api/staff", { preHandler: requirePermission("staff:directory") }, async (request) => ({
    staff: await listMembers(
      db,
      contextOf(request),
      request.query as { category?: string; department?: string; status?: string; q?: string },
    ),
  }));
  app.post("/api/staff", { preHandler: manage }, async (request, reply) => {
    const { account, ...fields } = parseWith(NewMember, request.body);
    const ctx = contextOf(request);
    const role = account
      ? (account.role ?? (DEFAULT_ROLE[fields.category] as Role | undefined))
      : undefined;
    if (account && !role)
      throw new DomainError(
        "role_required",
        "Cette catégorie n'a pas de rôle par défaut : indiquez le rôle du compte.",
        400,
      );
    const member = await createMember(db, ctx, fields);
    if (!account || !role) return reply.status(201).send(member);
    try {
      const created = await createAccount(
        db,
        ctx,
        {
          username: account.username,
          email: account.email,
          role,
          temporaryPassword: account.temporaryPassword,
        },
        directory,
      );
      await linkAccount(db, ctx, member.id, created.id);
      return reply
        .status(201)
        .send({ ...member, userId: created.id, account: { username: account.username, role } });
    } catch (error) {
      // La fiche existe : les ressources humaines rattachent le compte plus tard.
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "account_creation_failed",
        "La fiche est créée mais le compte n'a pas pu l'être : rattachez-le plus tard.",
        502,
        { memberId: member.id },
      );
    }
  });

  app.get("/api/staff/:id", { preHandler: requirePermission("staff:directory") }, async (request) =>
    getMember(db, contextOf(request), id(request)),
  );
  app.put("/api/staff/:id", { preHandler: manage }, async (request) => {
    const body = parseWith(MemberUpdate, request.body);
    if (Object.keys(body).length === 0)
      throw new DomainError("empty_update", "Aucune modification envoyée.", 400);
    return updateMember(db, contextOf(request), id(request), body);
  });
  app.post("/api/staff/:id/status", { preHandler: manage }, async (request) => {
    const r = await setStatus(db, contextOf(request), id(request), parseWith(Status, request.body));
    return { ...r, directorySync: await syncAccount(r.userId, r.account) };
  });
  app.post("/api/staff/:id/link", { preHandler: manage }, async (request) =>
    linkAccount(db, contextOf(request), id(request), parseWith(Link, request.body).userId),
  );
  app.post("/api/staff/:id/unlink", { preHandler: manage }, async (request) =>
    unlinkAccount(db, contextOf(request), id(request)),
  );
  app.post("/api/staff/:id/qualifications", { preHandler: manage }, async (request, reply) =>
    reply
      .status(201)
      .send(
        await addQualification(
          db,
          contextOf(request),
          id(request),
          parseWith(Qualification, request.body),
        ),
      ),
  );
}
