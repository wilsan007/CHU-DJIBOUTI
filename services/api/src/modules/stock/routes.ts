import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { DomainError } from "../../errors.ts";
import { contextOf, parseWith, requireAnyPermission, requirePermission } from "../../http.ts";
import {
  alerts,
  consumeManual,
  createDepot,
  createPurchaseOrder,
  getPurchaseOrder,
  importItems,
  inventory,
  listDepots,
  listItems,
  listPurchaseOrders,
  listRecipes,
  listShortfalls,
  lotTrace,
  receiveStock,
  resolveShortfall,
  setRecipe,
  setThreshold,
  stockOverview,
  transfer,
} from "./service.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const qty = z.number().int().positive().max(1_000_000);
const Depot = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["pharmacy", "store", "ward", "lab", "imaging", "bloc"]).optional(),
  servesDepartment: z.string().trim().min(1).max(20).nullable().optional(),
});
const Threshold = z.object({ minimum: z.number().int().min(0).max(1_000_000) });
const Order = z.object({
  supplier: z.string().trim().min(1).max(200),
  lines: z
    .array(z.object({ itemCode: z.string().trim().min(1), quantity: qty }))
    .min(1)
    .max(100),
});
const Receipt = z.object({
  depot: z.string().min(1),
  orderId: z.string().uuid().optional(),
  lines: z
    .array(
      z.object({
        itemCode: z.string().trim().min(1),
        lotNumber: z.string().trim().min(1).max(60),
        expiresOn: date,
        quantity: qty,
      }),
    )
    .min(1)
    .max(100),
});
const Inventory = z.object({
  depot: z.string().min(1),
  counts: z
    .array(z.object({ lotId: z.string().uuid(), counted: z.number().int().min(0).max(1_000_000) }))
    .min(1)
    .max(500),
  reason: z.string().max(500).optional(),
  apply: z.boolean().default(false),
});
const Transfer = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  lines: z
    .array(z.object({ lotId: z.string().uuid(), quantity: qty }))
    .min(1)
    .max(100),
  note: z.string().trim().max(300).optional(),
});
const Recipe = z.object({
  items: z
    .array(
      z.object({
        itemCode: z.string().trim().min(1),
        quantity: z.number().int().positive().max(10_000),
      }),
    )
    .max(50),
  responsible: z.string().trim().min(1).max(120),
  updatedOn: date,
});
const Consume = z.object({
  depot: z.string().min(1),
  itemCode: z.string().trim().min(1),
  quantity: qty,
  patientId: z.string().uuid().optional(),
  reason: z.string().trim().min(3).max(300),
});
const StockQuery = z.object({ depot: z.string().optional(), itemCode: z.string().optional() });

export async function registerStockRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const param = (request: { params: unknown }, name: string) =>
    (request.params as Record<string, string>)[name] as string;
  const read = requireAnyPermission("stock:read", "stock:consume");
  const manage = requirePermission("stock:manage");

  app.get("/api/stock/depots", { preHandler: read }, async () => ({
    depots: await listDepots(db),
  }));
  app.post("/api/stock/depots", { preHandler: manage }, async (request, reply) =>
    reply
      .status(201)
      .send(await createDepot(db, contextOf(request), parseWith(Depot, request.body))),
  );
  app.get("/api/stock/items", { preHandler: read }, async (request) => ({
    items: await listItems(db, request.query as { kind?: string; q?: string }),
  }));
  app.post(
    "/api/stock/items/import",
    { preHandler: manage, bodyLimit: 2 * 1024 * 1024 },
    async (request) => {
      if (typeof request.body !== "string")
        throw new DomainError(
          "invalid_body",
          "Envoyez le fichier CSV avec l'en-tête Content-Type: text/csv.",
          400,
        );
      return importItems(db, contextOf(request), request.body);
    },
  );
  app.get("/api/stock/levels", { preHandler: requirePermission("stock:read") }, async (request) =>
    stockOverview(db, parseWith(StockQuery, request.query)),
  );
  app.put("/api/stock/thresholds/:itemCode", { preHandler: manage }, async (request) =>
    setThreshold(
      db,
      contextOf(request),
      param(request, "itemCode"),
      parseWith(Threshold, request.body).minimum,
    ),
  );
  app.get("/api/stock/alerts", { preHandler: requirePermission("stock:read") }, async () =>
    alerts(db),
  );

  app.post("/api/stock/orders", { preHandler: manage }, async (request, reply) =>
    reply
      .status(201)
      .send(await createPurchaseOrder(db, contextOf(request), parseWith(Order, request.body))),
  );
  app.get("/api/stock/orders", { preHandler: manage }, async (request) => ({
    orders: await listPurchaseOrders(db, (request.query as { status?: string }).status),
  }));
  app.get("/api/stock/orders/:id", { preHandler: manage }, async (request) =>
    getPurchaseOrder(db, param(request, "id")),
  );
  app.post("/api/stock/receipts", { preHandler: manage }, async (request, reply) =>
    reply
      .status(201)
      .send(await receiveStock(db, contextOf(request), parseWith(Receipt, request.body))),
  );
  app.post("/api/stock/inventory", { preHandler: manage }, async (request) =>
    inventory(db, contextOf(request), parseWith(Inventory, request.body)),
  );
  app.post("/api/stock/transfers", { preHandler: manage }, async (request, reply) =>
    reply
      .status(201)
      .send(await transfer(db, contextOf(request), parseWith(Transfer, request.body))),
  );
  app.get("/api/stock/lots/:id/patients", { preHandler: manage }, async (request) =>
    lotTrace(db, contextOf(request), param(request, "id")),
  );

  app.get(
    "/api/stock/recipes",
    { preHandler: requireAnyPermission("stock:read", "stock:recipes") },
    async (request) => ({
      recipes: await listRecipes(db, (request.query as { act?: string }).act),
    }),
  );
  app.put(
    "/api/stock/recipes/:actCode",
    { preHandler: requirePermission("stock:recipes") },
    async (request) =>
      setRecipe(db, contextOf(request), param(request, "actCode"), parseWith(Recipe, request.body)),
  );
  app.post(
    "/api/stock/consumptions",
    { preHandler: requirePermission("stock:consume") },
    async (request, reply) =>
      reply
        .status(201)
        .send(await consumeManual(db, contextOf(request), parseWith(Consume, request.body))),
  );
  app.get("/api/stock/shortfalls", { preHandler: manage }, async (request) => ({
    shortfalls: await listShortfalls(db, (request.query as { all?: string }).all !== "true"),
  }));
  app.post("/api/stock/shortfalls/:id/resolve", { preHandler: manage }, async (request) =>
    resolveShortfall(
      db,
      contextOf(request),
      Number(param(request, "id")),
      parseWith(z.object({ resolution: z.string().trim().min(5).max(300) }), request.body)
        .resolution,
    ),
  );
}
