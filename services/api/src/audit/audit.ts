import type { AuthUser } from "../auth/jwt.ts";
import type { Tx } from "../db.ts";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  patientId?: string | null;
  detail?: Record<string, unknown>;
}

export interface RequestContext {
  user: AuthUser;
  requestId: string;
}

/**
 * Écrit une ligne dans le journal d'audit, dans la transaction de l'action elle-même :
 * pas d'action sans trace, pas de trace sans action.
 */
export async function writeAudit(tx: Tx, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  await tx.query(
    `insert into audit.log (actor_id, actor_roles, action, entity_type, entity_id, patient_id, request_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ctx.user.id,
      ctx.user.roles,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.patientId ?? null,
      ctx.requestId,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
