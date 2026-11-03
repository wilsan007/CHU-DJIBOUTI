import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import type { AuthUser } from "../../auth/jwt.ts";
import { ROLES, type Role } from "../../auth/permissions.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import type { UserDirectory } from "./directory.ts";

/**
 * Contrôle d'accès commun à tous les modules, appelé à chaque requête authentifiée : un compte désactivé est refusé
 * tout de suite, même avec un jeton encore valide. Un compte inconnu est enregistré à sa première requête.
 */
export async function checkAccount(db: Db, user: AuthUser): Promise<void> {
  const res = await db.query<{ status: string; roles: string[]; stale: boolean }>(
    "select status, roles, last_seen < now() - interval '10 minutes' as stale from admin.users where id = $1",
    [user.id],
  );
  const row = res.rows[0];
  if (!row) {
    await db.query(
      "insert into admin.users (id, username, roles) values ($1, $2, $3) on conflict (id) do nothing",
      [user.id, user.name, user.roles],
    );
    return;
  }
  if (row.status === "disabled")
    throw new DomainError(
      "account_disabled",
      "Ce compte est désactivé. Contactez l'administration.",
      403,
    );
  const same =
    row.roles.length === user.roles.length &&
    row.roles.every((r) => user.roles.includes(r as Role));
  if (!same || row.stale)
    await db.query(
      "update admin.users set roles = $2, username = $3, last_seen = now() where id = $1",
      [user.id, user.roles, user.name],
    );
}

export async function listUsers(db: Db, status?: string) {
  const res = await db.query<{
    id: string;
    username: string;
    roles: string[];
    status: string;
    last_seen: Date;
    disabled_at: Date | null;
    disabled_by: string | null;
    disabled_reason: string | null;
  }>(
    `select id, username, roles, status, last_seen, disabled_at, disabled_by, disabled_reason
       from admin.users where ($1::text is null or status = $1) order by username, id limit 500`,
    [status ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    username: r.username,
    roles: r.roles,
    status: r.status,
    lastSeen: r.last_seen.toISOString(),
    disabledAt: r.disabled_at?.toISOString() ?? null,
    disabledBy: r.disabled_by,
    disabledReason: r.disabled_reason,
  }));
}

/** Désactive ou réactive. Le registre local est la référence ; l'annuaire est synchronisé ensuite (et son échec est signalé). */
export async function setStatus(
  db: Db,
  ctx: RequestContext,
  id: string,
  action: "disable" | "enable",
  reason: string,
  directory: UserDirectory | null,
) {
  if (action === "disable" && id === ctx.user.id)
    throw new DomainError(
      "cannot_disable_self",
      "Vous ne pouvez pas désactiver votre propre compte.",
      409,
    );
  await withTransaction(db, async (tx) => {
    const found = await tx.query<{ status: string }>(
      "select status from admin.users where id = $1 for update",
      [id],
    );
    if (!found.rows[0]) throw notFound("Compte");
    if (action === "disable") {
      await tx.query(
        "update admin.users set status = 'disabled', disabled_at = now(), disabled_by = $2, disabled_reason = $3 where id = $1",
        [id, ctx.user.id, reason],
      );
    } else {
      await tx.query(
        "update admin.users set status = 'active', disabled_at = null, disabled_by = null, disabled_reason = null where id = $1",
        [id],
      );
    }
    await writeAudit(tx, ctx, {
      action: `admin.user.${action}`,
      entityType: "user",
      entityId: id,
      detail: { reason },
    });
  });
  let directorySync: boolean | null = null;
  if (directory) {
    try {
      await directory.setEnabled(id, action === "enable");
      directorySync = true;
    } catch {
      directorySync = false;
    }
  }
  return { id, status: action === "disable" ? "disabled" : "active", directorySync };
}

/**
 * Désactive ou réactive un compte dans la transaction de l'appelant (les ressources humaines coupent l'accès d'un agent
 * qui part). Un compte qui ne s'est jamais connecté est enregistré désactivé : il ne pourra pas se connecter plus tard.
 */
export async function setAccountStatusIn(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  action: "disable" | "enable",
  reason: string,
): Promise<void> {
  if (action === "disable") {
    await tx.query(
      `insert into admin.users (id, username, status, disabled_at, disabled_by, disabled_reason)
       values ($1, $1, 'disabled', now(), $2, $3)
       on conflict (id) do update set status = 'disabled', disabled_at = now(), disabled_by = $2, disabled_reason = $3`,
      [id, ctx.user.id, reason],
    );
  } else {
    await tx.query(
      "update admin.users set status = 'active', disabled_at = null, disabled_by = null, disabled_reason = null where id = $1",
      [id],
    );
  }
  await writeAudit(tx, ctx, {
    action: `admin.user.${action}`,
    entityType: "user",
    entityId: id,
    detail: { reason },
  });
}

export async function createUser(
  db: Db,
  ctx: RequestContext,
  input: { username: string; email: string; role: Role; temporaryPassword: string },
  directory: UserDirectory | null,
) {
  if (!directory)
    throw new DomainError(
      "directory_not_configured",
      "L'annuaire Keycloak n'est pas configuré.",
      501,
    );
  const { id } = await directory.createUser(input);
  await withTransaction(db, async (tx) => {
    await tx.query(
      "insert into admin.users (id, username, roles) values ($1, $2, $3) on conflict (id) do update set username = $2, roles = $3",
      [id, input.username, [input.role]],
    );
    await writeAudit(tx, ctx, {
      action: "admin.user.create",
      entityType: "user",
      entityId: id,
      detail: { username: input.username, role: input.role },
    });
  });
  return { id, username: input.username, roles: [input.role] };
}

export async function changeRole(
  db: Db,
  ctx: RequestContext,
  id: string,
  role: Role,
  directory: UserDirectory | null,
) {
  if (!directory)
    throw new DomainError(
      "directory_not_configured",
      "L'annuaire Keycloak n'est pas configuré.",
      501,
    );
  await directory.setRole(id, role, ROLES);
  await withTransaction(db, async (tx) => {
    const res = await tx.query("update admin.users set roles = $2 where id = $1", [id, [role]]);
    if (!res.rowCount) throw notFound("Compte");
    await writeAudit(tx, ctx, {
      action: "admin.user.role",
      entityType: "user",
      entityId: id,
      detail: { role },
    });
  });
  return { id, roles: [role] };
}
