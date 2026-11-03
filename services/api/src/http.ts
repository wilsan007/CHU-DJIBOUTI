import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import type { RequestContext } from "./audit/audit.ts";
import type { AuthUser } from "./auth/jwt.ts";
import { can, type Permission } from "./auth/permissions.ts";
import { DomainError } from "./errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    requestId: string;
  }
}

/** Valide `data` avec un schéma zod ; en cas d'échec, lève une erreur 400 lisible. */
export function parseWith<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DomainError("validation_error", "Les données envoyées sont invalides.", 400, {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

/** Contrôle d'accès par droit : 401 sans jeton valide, 403 si le rôle n'a pas le droit. */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
    }
    if (!can(request.user.roles, permission)) {
      throw new DomainError("forbidden", "Vous n'avez pas le droit d'effectuer cette action.", 403);
    }
  };
}

/** Droit accordé par l'un ou l'autre de plusieurs droits (ex. remise de la caisse ou de la direction). */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
    }
    const roles = request.user.roles;
    if (!permissions.some((p) => can(roles, p))) {
      throw new DomainError("forbidden", "Vous n'avez pas le droit d'effectuer cette action.", 403);
    }
  };
}

export function contextOf(request: FastifyRequest): RequestContext {
  if (!request.user)
    throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
  return { user: request.user, requestId: request.requestId };
}
