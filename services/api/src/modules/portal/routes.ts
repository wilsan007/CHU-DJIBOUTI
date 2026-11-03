import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError } from "../../errors.ts";
import type { Db } from "../../db.ts";
import { parseWith } from "../../http.ts";
import {
  authenticatePatient,
  bookable,
  bookMine,
  cancelMine,
  freeSlots,
  logout,
  myAppointments,
  myInvoices,
  myResults,
  profile,
  requestOtp,
  verifyOtp,
  type PatientSession,
  type PortalConfig,
} from "./service.ts";

declare module "fastify" {
  interface FastifyRequest {
    patient: PatientSession | null;
  }
  interface FastifyInstance {
    portalRoutes: { method: string; url: string }[];
  }
}

const Identifier = z.string().trim().min(3).max(40);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Routes du portail patient, toutes sous `/api/portal/`. Le crochet global d'authentification du personnel les laisse
 * passer (le patient n'a pas de compte Keycloak) ; ICI, tout ce qui n'est pas la demande ou la vérification d'un code
 * exige une session de patient valide. Le patient n'agit jamais que sur son propre dossier : l'identifiant vient de la
 * session, jamais de l'adresse ou du corps de la requête.
 */
export async function registerPortalRoutes(
  app: FastifyInstance,
  db: Db,
  cfg: PortalConfig,
): Promise<void> {
  app.decorateRequest("patient", null);
  // Table des routes du portail, gardée pour le test « aucune route ouverte par oubli ».
  const portalRoutes: { method: string; url: string }[] = [];
  app.decorate("portalRoutes", portalRoutes);
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith("/api/portal/"))
      portalRoutes.push({ method: String(route.method), url: route.url });
  });
  const ip = (r: FastifyRequest): string => r.ip;

  await app.register(async (open) => {
    open.post("/api/portal/otp/request", async (request, reply) => {
      const b = parseWith(z.object({ identifier: Identifier }), request.body);
      await requestOtp(db, cfg, { identifier: b.identifier, ip: ip(request) });
      return reply.status(202).send({ ok: true }); // même réponse dans tous les cas
    });
    open.post("/api/portal/otp/verify", async (request) => {
      const b = parseWith(
        z.object({ identifier: Identifier, code: z.string().regex(/^\d{6}$/) }),
        request.body,
      );
      return verifyOtp(db, cfg, { identifier: b.identifier, code: b.code, ip: ip(request) });
    });
  });

  await app.register(async (secured) => {
    secured.addHook("onRequest", async (request) => {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer "))
        throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
      request.patient = await authenticatePatient(db, cfg, header.slice("Bearer ".length));
    });
    const me = (r: FastifyRequest): PatientSession => {
      if (!r.patient)
        throw new DomainError("unauthenticated", "Connectez-vous pour continuer.", 401);
      return r.patient;
    };

    secured.get("/api/portal/me", async (r) => profile(db, me(r)));
    secured.post("/api/portal/logout", async (r, reply) => {
      await logout(db, me(r));
      return reply.status(204).send();
    });
    secured.get("/api/portal/me/appointments", async (r) => ({
      appointments: await myAppointments(db, me(r)),
    }));
    secured.get("/api/portal/practitioners", async () => ({ practitioners: await bookable(db) }));
    secured.get("/api/portal/practitioners/:id/slots", async (r) => {
      const { date } = parseWith(z.object({ date: day }), r.query);
      return { slots: await freeSlots(db, (r.params as { id: string }).id, date) };
    });
    secured.post("/api/portal/me/appointments", async (r, reply) => {
      const b = parseWith(
        z.object({
          practitionerId: z.string().min(1).max(80),
          startsAt: z.string().datetime({ offset: true }),
        }),
        r.body,
      );
      return reply
        .status(201)
        .send(
          await bookMine(
            db,
            me(r),
            { practitionerId: b.practitionerId, startsAt: new Date(b.startsAt) },
            r.id,
          ),
        );
    });
    secured.post("/api/portal/me/appointments/:id/cancel", async (r) =>
      cancelMine(db, me(r), (r.params as { id: string }).id, r.id),
    );
    secured.get("/api/portal/me/results", async (r) => myResults(db, cfg, me(r), r.id));
    secured.get("/api/portal/me/invoices", async (r) => ({
      invoices: await myInvoices(db, me(r), r.id),
    }));
  });
}
