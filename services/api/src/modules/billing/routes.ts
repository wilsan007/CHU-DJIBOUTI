import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contextOf, parseWith, requireAnyPermission, requirePermission } from "../../http.ts";
import type { Db } from "../../db.ts";
import {
  AdmitSchema,
  CloseSessionSchema,
  CreditSchema,
  InvoiceListSchema,
  PaySchema,
  QuoteSchema,
  RevenueSchema,
} from "./schemas.ts";
import {
  admit,
  closeCashSession,
  creditInvoice,
  currentCashSession,
  getInvoice,
  getReceipt,
  listInvoices,
  applyDiscount,
  openCashSession,
  payInvoice,
  quote,
  revenueCsv,
  revenueReport,
} from "./service.ts";

const DiscountSchema = z.object({
  percent: z.number().min(0).max(100).optional(),
  amount: z.number().int().min(0).optional(),
  reason: z.string().trim().min(3).max(300),
});

export async function registerBillingRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Remise accordée à la caisse (ou par la direction au-delà du plafond) avant le paiement.
  app.post(
    "/api/billing/invoices/:id/discount",
    { preHandler: requireAnyPermission("billing:discount", "billing:discount-any") },
    async (request) =>
      applyDiscount(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        parseWith(DiscountSchema, request.body),
      ),
  );

  // F2-1 : admission rapide ; ouvre l'acte à facturer.
  app.post(
    "/api/admissions",
    { preHandler: requirePermission("billing:admit") },
    async (request, reply) => {
      const result = await admit(db, contextOf(request), parseWith(AdmitSchema, request.body));
      return reply.status(201).send(result);
    },
  );

  // F2-4 : devis avant l'acte, rien n'est enregistré.
  app.post(
    "/api/billing/quotes",
    { preHandler: requirePermission("billing:read") },
    async (request) => quote(db, parseWith(QuoteSchema, request.body)),
  );

  // La caisse voit les factures à encaisser (statut pending), dont celles des demandes du médecin.
  app.get(
    "/api/billing/invoices",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const f = parseWith(InvoiceListSchema, request.query);
      return {
        invoices: await listInvoices(db, {
          limit: f.limit,
          newest: f.newest === "true",
          ...(f.status ? { status: f.status } : {}),
          ...(f.patientId ? { patientId: f.patientId } : {}),
          ...(f.orderNumber ? { orderNumber: f.orderNumber } : {}),
        }),
      };
    },
  );

  app.get(
    "/api/billing/invoices/:id",
    { preHandler: requirePermission("billing:read") },
    async (request) => getInvoice(db, (request.params as { id: string }).id),
  );

  app.get(
    "/api/billing/invoices/:id/receipt",
    { preHandler: requirePermission("billing:read") },
    async (request) => getReceipt(db, (request.params as { id: string }).id),
  );

  // La validation de la caisse : seule la caisse a ce droit.
  app.post(
    "/api/billing/invoices/:id/pay",
    { preHandler: requirePermission("billing:pay") },
    async (request) => {
      const input = parseWith(PaySchema, request.body);
      return payInvoice(db, contextOf(request), (request.params as { id: string }).id, input);
    },
  );

  // F2-4 : une facture émise ne se modifie pas, elle se corrige par un avoir.
  app.post(
    "/api/billing/invoices/:id/credit-note",
    { preHandler: requirePermission("billing:credit") },
    async (request, reply) => {
      const { reason } = parseWith(CreditSchema, request.body);
      const result = await creditInvoice(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        reason,
      );
      return reply.status(201).send(result);
    },
  );

  // F2-5 : caisse du jour.
  app.post(
    "/api/billing/cash-sessions/open",
    { preHandler: requirePermission("billing:pay") },
    async (request, reply) => reply.status(201).send(await openCashSession(db, contextOf(request))),
  );
  app.get(
    "/api/billing/cash-sessions/current",
    { preHandler: requirePermission("billing:pay") },
    async (request) => ({
      session: await currentCashSession(db, contextOf(request).user.id),
    }),
  );
  app.post(
    "/api/billing/cash-sessions/:id/close",
    { preHandler: requirePermission("billing:pay") },
    async (request) => {
      const { countedCash } = parseWith(CloseSessionSchema, request.body);
      return closeCashSession(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        countedCash,
      );
    },
  );

  // F2-6 : recettes par jour, service ou caissier ; export CSV.
  app.get(
    "/api/billing/reports/revenue",
    { preHandler: requirePermission("billing:report") },
    async (request, reply) => {
      const q = parseWith(RevenueSchema, request.query);
      const report = await revenueReport(db, { from: q.from, to: q.to, groupBy: q.groupBy });
      if (q.format === "csv") {
        void reply.header("content-type", "text/csv; charset=utf-8");
        return reply.send(revenueCsv(report));
      }
      return report;
    },
  );
}
