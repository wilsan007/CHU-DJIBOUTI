import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isRole, type Role } from "./permissions.ts";

export interface AuthUser {
  id: string;
  name: string;
  roles: Role[];
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

export interface VerifierOptions {
  issuer: string;
  audience: string;
  /** Clés de vérification : ensemble distant (Keycloak) ou local (tests). */
  keys: JWTVerifyGetKey;
}

export class InvalidTokenError extends Error {}

/**
 * Vérifie un jeton OpenID Connect émis par Keycloak : signature, émetteur, public visé, expiration.
 * Les rôles sont lus dans `realm_access.roles` ; les rôles inconnus sont ignorés.
 */
export function createTokenVerifier(options: VerifierOptions): TokenVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["RS256", "ES256", "PS256"],
        clockTolerance: 5,
      });
      if (!payload.sub) throw new InvalidTokenError("sub manquant");
      const realm = payload.realm_access as { roles?: unknown } | undefined;
      const raw = Array.isArray(realm?.roles) ? realm.roles : [];
      const roles = raw.filter((r): r is string => typeof r === "string").filter(isRole);
      const name =
        typeof payload.preferred_username === "string" ? payload.preferred_username : payload.sub;
      return { id: payload.sub, name, roles };
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError((error as Error).message);
    }
  };
}

/** Ensemble de clés distant, mis en cache et renouvelé automatiquement par la bibliothèque. */
export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl));
}
