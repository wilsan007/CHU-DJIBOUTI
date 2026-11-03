import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { InvalidTokenError, type TokenVerifier } from "./auth/jwt.ts";
import { can, PERMISSIONS } from "./auth/permissions.ts";
import type { Db } from "./db.ts";
import { DomainError } from "./errors.ts";
import { registerAppointmentRoutes } from "./modules/appointments/routes.ts";
import { registerHistoryRoutes } from "./history.ts";
import { registerClinicalRoutes } from "./modules/clinical/routes.ts";
import type { UserDirectory } from "./modules/admin/directory.ts";
import { registerAdminRoutes } from "./modules/admin/routes.ts";
import { checkAccount } from "./modules/admin/service.ts";
import { registerDashboardRoutes } from "./modules/dashboard/routes.ts";
import { registerHospitalizationRoutes } from "./modules/hospitalization/routes.ts";
import type { PacsConfig } from "./modules/imaging/pacs.ts";
import { registerPortalRoutes } from "./modules/portal/routes.ts";
import type { PortalConfig } from "./modules/portal/service.ts";
import { registerImagingRoutes } from "./modules/imaging/routes.ts";
import { registerStaffRoutes } from "./modules/staff/routes.ts";
import { registerStockRoutes } from "./modules/stock/routes.ts";
import { registerLabRoutes } from "./modules/lab/routes.ts";
import { registerPharmacyRoutes } from "./modules/pharmacy/routes.ts";
import { registerPrescriptionRoutes } from "./modules/prescriptions/routes.ts";
import { registerBillingRoutes } from "./modules/billing/routes.ts";
import { registerCatalogRoutes } from "./modules/catalog/routes.ts";
import { registerIdentityRoutes } from "./modules/identity/routes.ts";
import { registerOrderRoutes } from "./modules/orders/routes.ts";

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  /** Annuaire des comptes (Keycloak) ; absent : la création de comptes est refusée, la désactivation reste locale. */
  directory?: UserDirectory | null;
  logger?: boolean;
  /** Serveur d'images DICOM (Orthanc) ; absent ou null : les routes d'images DICOM répondent « non configuré ». */
  pacs?: PacsConfig | null;
  /** Portail patient (code par SMS) ; absent : les routes `/api/portal/` ne sont pas ouvertes. */
  portal?: PortalConfig | null;
  /**
   * Mandataire de confiance (Nginx) : l'adresse du client vient alors de X-Forwarded-For. Sans cela, derrière Nginx, tous
   * les patients partageraient l'adresse du mandataire et les limites par adresse du portail seraient communes.
   * Ne l'activer que si l'API n'est joignable QUE par le mandataire (sinon l'en-tête peut être falsifié).
   */
  trustProxy?: boolean | string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: () => randomUUID(),
    ...(deps.trustProxy !== undefined ? { trustProxy: deps.trustProxy } : {}),
  });
  app.decorateRequest("user", null);
  app.decorateRequest("requestId", "");

  app.addHook("onRequest", async (request, reply) => {
    request.requestId = request.id;
    void reply.header("x-request-id", request.id);
    if (!request.url.startsWith("/api/")) return;
    // Portail patient : son authentification (code par SMS, session de patient) est faite par ses propres routes.
    if (request.url.startsWith("/api/portal/")) return;
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
    }
    try {
      request.user = await deps.verifier(header.slice("Bearer ".length));
      await checkAccount(deps.db, request.user);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw new DomainError(
          "unauthenticated",
          "Session invalide ou expirée. Reconnectez-vous.",
          401,
        );
      }
      throw error;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "validation_error", message: "Les données envoyées sont invalides." },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: "bad_request", message: "Requête invalide." },
      });
    }
    request.log.error(error);
    if (process.env.CHU_DEBUG_ERRORS) console.error(error);
    // Aucun détail technique pour l'utilisateur ; l'identifiant de requête permet de retrouver le journal.
    return reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Une erreur s'est produite. Vos saisies sont conservées, vous pouvez réessayer.",
        requestId: request.requestId,
      },
    });
  });

  app.get("/health", async (_request, reply) => {
    try {
      await deps.db.query("select 1");
      return { status: "ok", db: "ok" };
    } catch {
      return reply.status(503).send({ status: "degraded", db: "unavailable" });
    }
  });

  // Supervision (Prometheus). Aucun contenu patient : seulement des compteurs. À n'exposer que sur le réseau interne.
  app.get("/metrics", async (_request, reply) => {
    const lines = ["# TYPE chu_api_up gauge"];
    try {
      const pending = await deps.db.query<{ n: string }>(
        `select count(*) as n from events.outbox
          where id > coalesce((select min(last_id) from events.consumer_cursor), 0)`,
      );
      const dead = await deps.db.query<{ n: string }>(
        "select count(*) as n from events.failures where dead",
      );
      lines.push(
        "chu_api_up 1",
        "# TYPE chu_events_dead gauge",
        `chu_events_dead ${dead.rows[0]?.n ?? 0}`,
        "# TYPE chu_events_backlog gauge",
        `chu_events_backlog ${pending.rows[0]?.n ?? 0}`,
      );
    } catch {
      lines.push("chu_api_up 0");
    }
    return reply.header("content-type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  // Qui suis-je : le portail adapte ses écrans aux droits de la personne connectée.
  app.get("/api/me", async (request) => {
    const user = request.user;
    if (!user) throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
    const permissions = PERMISSIONS.filter((p) => can(user.roles, p));
    return { id: user.id, name: user.name, roles: user.roles, permissions };
  });

  await registerIdentityRoutes(app, deps.db);
  await registerCatalogRoutes(app, deps.db);
  await registerBillingRoutes(app, deps.db);
  await registerOrderRoutes(app, deps.db);
  await registerAppointmentRoutes(app, deps.db);
  await registerClinicalRoutes(app, deps.db);
  await registerPrescriptionRoutes(app, deps.db);
  await registerPharmacyRoutes(app, deps.db);
  await registerStockRoutes(app, deps.db);
  await registerLabRoutes(app, deps.db);
  await registerImagingRoutes(app, deps.db, deps.pacs ?? null);
  if (deps.portal) await registerPortalRoutes(app, deps.db, deps.portal);
  await registerHospitalizationRoutes(app, deps.db);
  await registerAdminRoutes(app, deps.db, deps.directory ?? null);
  await registerStaffRoutes(app, deps.db, deps.directory ?? null);
  await registerDashboardRoutes(app, deps.db);
  await registerHistoryRoutes(app, deps.db);
  return app;
}
