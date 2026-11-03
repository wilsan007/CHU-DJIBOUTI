import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.ts";
import { allConsumers } from "../../src/consumers.ts";
import { Dispatcher } from "../../src/events/dispatcher.ts";
import { createTokenVerifier } from "../../src/auth/jwt.ts";
import type { Role } from "../../src/auth/permissions.ts";
import type { Db } from "../../src/db.ts";
import type { PacsConfig } from "../../src/modules/imaging/pacs.ts";
import type { UserDirectory } from "../../src/modules/admin/directory.ts";

export const ISSUER = "https://keycloak.test/realms/chu";
export const AUDIENCE = "chu-api";

export interface TestApp {
  app: FastifyInstance;
  /** Distributeur d'événements, non démarré : les tests appellent `drain()` quand ils en ont besoin. */
  dispatcher: Dispatcher;
  /** Signe un jeton comme le ferait Keycloak. */
  token: (
    roles: Role[],
    options?: { sub?: string; expiresIn?: string; issuer?: string; audience?: string },
  ) => Promise<string>;
  /** En-têtes d'authentification prêts à l'emploi. */
  as: (...roles: Role[]) => Promise<{ authorization: string }>;
  close: () => Promise<void>;
}

export async function createTestApp(
  db: Db,
  options: { directory?: UserDirectory; pacs?: PacsConfig | null } = {},
): Promise<TestApp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const verifier = createTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  const app = await buildApp({
    db,
    verifier,
    directory: options.directory ?? null,
    pacs: options.pacs ?? null,
  });
  const dispatcher = new Dispatcher({ db, consumers: allConsumers(), baseDelayMs: 1 });
  await app.ready();

  const token: TestApp["token"] = async (roles, options = {}) =>
    new SignJWT({ realm_access: { roles }, preferred_username: `user-${roles.join("-")}` })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject(options.sub ?? `sub-${roles.join("-") || "none"}`)
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey);

  return {
    app,
    dispatcher,
    token,
    as: async (...roles) => ({ authorization: `Bearer ${await token(roles)}` }),
    close: () => app.close(),
  };
}
