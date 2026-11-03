import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { parseCsv } from "../../common/csv.ts";
import { nextNumber } from "../../common/numbering.ts";
import { localDate } from "../../common/time.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { patientSummaries } from "../identity/interface.ts";

/** Alerte de péremption à 6 mois : la chaleur et les retards d'approvisionnement imposent de l'avance (décision bêta, Q16). */
export const EXPIRY_WARNING_DAYS = 180;

export type ItemKind = "drug" | "consumable" | "reagent" | "supply";

export const today = (): string => localDate(new Date());
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------ dépôts, seuils */

export async function listDepots(db: Db) {
  const res = await db.query<{
    code: string;
    name: string;
    active: boolean;
    kind: string;
    serves_department: string | null;
  }>("select code, name, active, kind, serves_department from stock.depots order by code");
  return res.rows.map((r) => ({
    code: r.code,
    name: r.name,
    active: r.active,
    kind: r.kind,
    servesDepartment: r.serves_department,
  }));
}

export async function createDepot(
  db: Db,
  ctx: RequestContext,
  input: {
    code: string;
    name: string;
    kind?: string | undefined;
    servesDepartment?: string | null | undefined;
  },
) {
  return withTransaction(db, async (tx) => {
    const dup = await tx.query("select 1 from stock.depots where code = $1", [input.code]);
    if (dup.rowCount) throw new DomainError("depot_exists", "Ce dépôt existe déjà.", 409);
    if (input.servesDepartment) {
      const taken = await tx.query("select 1 from stock.depots where serves_department = $1", [
        input.servesDepartment,
      ]);
      if (taken.rowCount)
        throw new DomainError(
          "department_has_depot",
          "Ce service a déjà un dépôt de consommation.",
          409,
        );
    }
    await tx.query(
      "insert into stock.depots (code, name, kind, serves_department) values ($1, $2, $3, $4)",
      [input.code, input.name, input.kind ?? "store", input.servesDepartment ?? null],
    );
    await writeAudit(tx, ctx, {
      action: "stock.depot",
      entityType: "depot",
      entityId: input.code,
    });
    return {
      code: input.code,
      name: input.name,
      active: true,
      kind: input.kind ?? "store",
      servesDepartment: input.servesDepartment ?? null,
    };
  });
}

export async function requireDepot(tx: Tx | Db, code: string): Promise<void> {
  const res = await tx.query("select 1 from stock.depots where code = $1 and active", [code]);
  if (!res.rowCount) throw new DomainError("unknown_depot", "Dépôt inconnu ou inactif.", 400);
}

export async function setThreshold(db: Db, ctx: RequestContext, itemCode: string, minimum: number) {
  return withTransaction(db, async (tx) => {
    const drug = await requireItem(tx, itemCode);
    assertCanManage(ctx, drug.kind);
    await tx.query(
      `insert into stock.thresholds (item_code, minimum, updated_by) values ($1, $2, $3)
       on conflict (item_code) do update set minimum = $2, updated_by = $3, updated_at = now()`,
      [drug.code, minimum, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "stock.threshold",
      entityType: "drug",
      entityId: drug.code,
      detail: { minimum },
    });
    return { itemCode: drug.code, minimum };
  });
}

/* ------------------------------------------------------------------ stock */

interface LotRow {
  lot_id: string;
  item_code: string;
  lot_number: string;
  expires_on: string;
  depot_code: string;
  quantity: number;
}

export function stockStatus(expiresOn: string): "expired" | "expiring" | "ok" {
  const now = today();
  if (expiresOn < now) return "expired";
  return expiresOn <= addDays(now, EXPIRY_WARNING_DAYS) ? "expiring" : "ok";
}

export async function stockOverview(
  db: Db,
  filter: { depot?: string | undefined; itemCode?: string | undefined },
) {
  const res = await db.query<
    LotRow & { label_fr: string; label_ar: string | null; kind: ItemKind; unit: string }
  >(
    `select s.lot_id, l.item_code, l.lot_number, l.expires_on::text as expires_on, s.depot_code, s.quantity,
            i.label_fr, i.label_ar, i.kind, i.unit
       from stock.stock_levels s
       join stock.lots l on l.id = s.lot_id
       join stock.items i on i.code = l.item_code
      where s.quantity > 0 and ($1::text is null or s.depot_code = $1) and ($2::text is null or l.item_code = $2)
      order by l.item_code, l.expires_on, l.lot_number, s.depot_code`,
    [filter.depot ?? null, filter.itemCode ?? null],
  );
  const lots = res.rows.map((r) => ({
    lotId: r.lot_id,
    itemCode: r.item_code,
    labelFr: r.label_fr,
    labelAr: r.label_ar,
    kind: r.kind,
    unit: r.unit,
    lotNumber: r.lot_number,
    expiresOn: r.expires_on,
    depot: r.depot_code,
    quantity: r.quantity,
    status: stockStatus(r.expires_on),
  }));
  const totals = new Map<string, number>();
  for (const l of lots) {
    if (l.status !== "expired") totals.set(l.itemCode, (totals.get(l.itemCode) ?? 0) + l.quantity);
  }
  return { lots, usableTotals: Object.fromEntries(totals) };
}

/** Quantité utilisable (lots non périmés), tous dépôts confondus. */
export async function usableTotal(tx: Tx | Db, itemCode: string): Promise<number> {
  const res = await tx.query<{ n: string | null }>(
    `select sum(s.quantity) as n from stock.stock_levels s join stock.lots l on l.id = s.lot_id
      where l.item_code = $1 and l.expires_on >= $2::date`,
    [itemCode, today()],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Publie StockBelowThreshold quand un mouvement fait passer le total sous le seuil (une fois, au franchissement). */
export async function checkThreshold(
  tx: Tx,
  ctx: RequestContext,
  itemCode: string,
  before: number,
) {
  const th = await tx.query<{ minimum: number }>(
    "select minimum from stock.thresholds where item_code = $1",
    [itemCode],
  );
  const minimum = th.rows[0]?.minimum;
  if (minimum === undefined) return;
  const after = await usableTotal(tx, itemCode);
  if (before >= minimum && after < minimum) {
    await appendEvent(tx, ctx, {
      type: "StockBelowThreshold",
      patientId: null,
      payload: { itemCode, total: after, minimum },
    });
  }
}

export async function move(
  tx: Tx,
  ctx: RequestContext,
  m: {
    depot: string;
    lotId: string;
    quantity: number;
    kind: "receipt" | "dispense" | "adjustment" | "consume" | "transfer_out" | "transfer_in";
    reason?: string;
    refType?: string;
    refId?: string;
    patientId?: string | null;
  },
): Promise<void> {
  await tx.query(
    `insert into stock.stock_levels (depot_code, lot_id, quantity) values ($1, $2, 0)
       on conflict do nothing`,
    [m.depot, m.lotId],
  );
  // Le solde est verrouillé puis modifié : la contrainte (>= 0) empêche tout stock négatif, même en cas de course.
  try {
    await tx.query(
      "update stock.stock_levels set quantity = quantity + $3 where depot_code = $1 and lot_id = $2",
      [m.depot, m.lotId, m.quantity],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23514")
      throw new DomainError("insufficient_stock", "Stock insuffisant pour ce lot.", 409);
    throw error;
  }
  await tx.query(
    `insert into stock.movements (depot_code, lot_id, quantity, kind, reason, ref_type, ref_id, user_id, user_name, patient_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      m.depot,
      m.lotId,
      m.quantity,
      m.kind,
      m.reason ?? null,
      m.refType ?? null,
      m.refId ?? null,
      ctx.user.id,
      ctx.user.name,
      m.patientId ?? null,
    ],
  );
}

/* ------------------------------------------------------------------ commandes et réceptions (F6-4) */

export interface OrderInput {
  supplier: string;
  lines: { itemCode: string; quantity: number }[];
}

export async function createPurchaseOrder(db: Db, ctx: RequestContext, input: OrderInput) {
  return withTransaction(db, async (tx) => {
    const codes = input.lines.map((l) => l.itemCode);
    if (new Set(codes).size !== codes.length)
      throw new DomainError(
        "duplicate_drug",
        "Un médicament figure deux fois dans la commande.",
        400,
      );
    for (const l of input.lines) assertCanManage(ctx, (await requireItem(tx, l.itemCode)).kind);
    const number = await nextNumber(tx, "stock", "purchase_order", "CMD");
    const order = await tx.query<{ id: string }>(
      `insert into stock.purchase_orders (number, supplier, created_by, created_by_name)
       values ($1, $2, $3, $4) returning id`,
      [number, input.supplier, ctx.user.id, ctx.user.name],
    );
    const id = order.rows[0]?.id as string;
    for (const l of input.lines) {
      await tx.query(
        "insert into stock.purchase_order_lines (order_id, item_code, ordered) values ($1, $2, $3)",
        [id, l.itemCode, l.quantity],
      );
    }
    await writeAudit(tx, ctx, {
      action: "stock.order",
      entityType: "purchase_order",
      entityId: id,
      detail: { number, supplier: input.supplier, lines: input.lines.length },
    });
    return getPurchaseOrderIn(tx, id);
  });
}

async function getPurchaseOrderIn(tx: Tx | Db, id: string) {
  const o = await tx.query<{
    id: string;
    number: string;
    supplier: string;
    status: string;
    created_by: string;
    created_at: Date;
  }>(
    "select id, number, supplier, status, created_by, created_at from stock.purchase_orders where id = $1",
    [id],
  );
  const row = o.rows[0];
  if (!row) throw notFound("Commande");
  const lines = await tx.query<{
    id: string;
    item_code: string;
    ordered: number;
    received: number;
  }>(
    "select id, item_code, ordered, received from stock.purchase_order_lines where order_id = $1 order by id",
    [id],
  );
  return {
    id: row.id,
    number: row.number,
    supplier: row.supplier,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lines: lines.rows.map((l) => ({
      lineId: l.id,
      itemCode: l.item_code,
      ordered: l.ordered,
      received: l.received,
    })),
  };
}

export async function getPurchaseOrder(db: Db, id: string) {
  return getPurchaseOrderIn(db, id);
}

export async function listPurchaseOrders(db: Db, status?: string) {
  const res = await db.query<{ id: string }>(
    "select id from stock.purchase_orders where ($1::text is null or status = $1) order by created_at desc limit 100",
    [status ?? null],
  );
  return Promise.all(res.rows.map((r) => getPurchaseOrderIn(db, r.id)));
}

export interface ReceiptInput {
  depot: string;
  orderId?: string | undefined;
  lines: {
    itemCode: string;
    lotNumber: string;
    expiresOn: string;
    quantity: number;
  }[];
}

/**
 * Réception : numéro de lot et date de péremption obligatoires. Avec une commande, la quantité reçue ne peut pas
 * dépasser le reste à recevoir ; sans commande (don, dépannage), la réception est tracée comme telle.
 */
export async function receiveStock(db: Db, ctx: RequestContext, input: ReceiptInput) {
  return withTransaction(db, async (tx) => {
    await requireDepot(tx, input.depot);
    let order: { id: string; status: string } | null = null;
    if (input.orderId) {
      const o = await tx.query<{ id: string; status: string }>(
        "select id, status from stock.purchase_orders where id = $1 for update",
        [input.orderId],
      );
      order = o.rows[0] ?? null;
      if (!order) throw notFound("Commande");
      if (order.status === "cancelled" || order.status === "received")
        throw new DomainError("order_closed", "Cette commande n'attend plus de livraison.", 409);
    }
    const received: { itemCode: string; lotNumber: string; quantity: number }[] = [];
    for (const l of input.lines) {
      assertCanManage(ctx, (await requireItem(tx, l.itemCode)).kind);
      if (l.expiresOn < today())
        throw new DomainError(
          "already_expired",
          `Le lot ${l.lotNumber} est déjà périmé : réception refusée.`,
          400,
        );
      if (order) {
        const line = await tx.query<{ id: string; ordered: number; received: number }>(
          "select id, ordered, received from stock.purchase_order_lines where order_id = $1 and item_code = $2 for update",
          [order.id, l.itemCode],
        );
        const ol = line.rows[0];
        if (!ol)
          throw new DomainError(
            "not_ordered",
            `${l.itemCode} ne figure pas dans la commande.`,
            400,
          );
        if (ol.received + l.quantity > ol.ordered)
          throw new DomainError(
            "over_receipt",
            `Quantité reçue supérieure au reste à recevoir pour ${l.itemCode} (reste ${ol.ordered - ol.received}).`,
            409,
          );
        await tx.query(
          "update stock.purchase_order_lines set received = received + $2 where id = $1",
          [ol.id, l.quantity],
        );
      }
      await tx.query(
        `insert into stock.lots (item_code, lot_number, expires_on) values ($1, $2, $3)
           on conflict (item_code, lot_number) do nothing`,
        [l.itemCode, l.lotNumber, l.expiresOn],
      );
      const lot = await tx.query<{ id: string; expires_on: string }>(
        "select id, expires_on::text as expires_on from stock.lots where item_code = $1 and lot_number = $2",
        [l.itemCode, l.lotNumber],
      );
      const lotRow = lot.rows[0] as { id: string; expires_on: string };
      if (lotRow.expires_on !== l.expiresOn)
        throw new DomainError(
          "lot_expiry_mismatch",
          `Le lot ${l.lotNumber} existe déjà avec une autre date de péremption (${lotRow.expires_on}).`,
          409,
        );
      await move(tx, ctx, {
        depot: input.depot,
        lotId: lotRow.id,
        quantity: l.quantity,
        kind: "receipt",
        refType: order ? "purchase_order" : "direct_receipt",
        ...(order ? { refId: order.id } : {}),
      });
      received.push({ itemCode: l.itemCode, lotNumber: l.lotNumber, quantity: l.quantity });
    }
    if (order) {
      const open = await tx.query<{ n: string }>(
        "select count(*) as n from stock.purchase_order_lines where order_id = $1 and received < ordered",
        [order.id],
      );
      await tx.query("update stock.purchase_orders set status = $2 where id = $1", [
        order.id,
        Number(open.rows[0]?.n) === 0 ? "received" : "partially_received",
      ]);
    }
    await writeAudit(tx, ctx, {
      action: "stock.receive",
      entityType: order ? "purchase_order" : "depot",
      entityId: order?.id ?? input.depot,
      detail: { depot: input.depot, orderId: order?.id ?? null, lines: received },
    });
    return { received, order: order ? await getPurchaseOrderIn(tx, order.id) : null };
  });
}

/* ------------------------------------------------------------------ alertes (F6-3) */

export async function alerts(db: Db) {
  const th = await db.query<{
    item_code: string;
    minimum: number;
    label_fr: string;
    label_ar: string | null;
  }>(
    `select t.item_code, t.minimum, i.label_fr, i.label_ar from stock.thresholds t join stock.items i on i.code = t.item_code order by t.item_code`,
  );
  const below = [];
  for (const t of th.rows) {
    const total = await usableTotal(db, t.item_code);
    if (total < t.minimum)
      below.push({
        itemCode: t.item_code,
        labelFr: t.label_fr,
        labelAr: t.label_ar,
        total,
        minimum: t.minimum,
      });
  }
  const limit = addDays(today(), EXPIRY_WARNING_DAYS);
  const exp = await db.query<{
    lot_id: string;
    item_code: string;
    lot_number: string;
    expires_on: string;
    depot_code: string;
    quantity: number;
  }>(
    `select s.lot_id, l.item_code, l.lot_number, l.expires_on::text as expires_on, s.depot_code, s.quantity
       from stock.stock_levels s join stock.lots l on l.id = s.lot_id
      where s.quantity > 0 and l.expires_on <= $1::date order by l.expires_on, l.lot_number`,
    [limit],
  );
  return {
    belowThreshold: below,
    expiry: exp.rows.map((r) => ({
      lotId: r.lot_id,
      itemCode: r.item_code,
      lotNumber: r.lot_number,
      expiresOn: r.expires_on,
      depot: r.depot_code,
      quantity: r.quantity,
      status: stockStatus(r.expires_on),
    })),
    warningDays: EXPIRY_WARNING_DAYS,
  };
}

/* ------------------------------------------------------------------ inventaire (F6-5) */

export interface InventoryInput {
  depot: string;
  counts: { lotId: string; counted: number }[];
  reason?: string | undefined;
  /** Faux : calcule les écarts sans rien modifier. */
  apply: boolean;
}

export async function inventory(db: Db, ctx: RequestContext, input: InventoryInput) {
  return withTransaction(db, async (tx) => {
    await requireDepot(tx, input.depot);
    const reason = input.reason?.trim() ?? "";
    if (input.apply && reason.length < 5)
      throw new DomainError(
        "reason_required",
        "Un motif écrit est obligatoire pour ajuster le stock.",
        400,
      );
    const gaps = [];
    const before = new Map<string, number>();
    for (const c of input.counts) {
      const row = await tx.query<{
        quantity: number;
        item_code: string;
        lot_number: string;
        kind: ItemKind;
      }>(
        `select coalesce(s.quantity, 0) as quantity, l.item_code, l.lot_number, i.kind
           from stock.lots l join stock.items i on i.code = l.item_code
           left join stock.stock_levels s on s.lot_id = l.id and s.depot_code = $1
          where l.id = $2 `,
        [input.depot, c.lotId],
      );
      const r = row.rows[0];
      if (!r) throw notFound("Lot");
      assertCanManage(ctx, r.kind);
      const gap = c.counted - r.quantity;
      gaps.push({
        lotId: c.lotId,
        itemCode: r.item_code,
        lotNumber: r.lot_number,
        expected: r.quantity,
        counted: c.counted,
        gap,
      });
      if (input.apply && gap !== 0) {
        if (!before.has(r.item_code)) before.set(r.item_code, await usableTotal(tx, r.item_code));
        await move(tx, ctx, {
          depot: input.depot,
          lotId: c.lotId,
          quantity: gap,
          kind: "adjustment",
          reason,
          refType: "inventory",
        });
      }
    }
    if (input.apply) {
      await writeAudit(tx, ctx, {
        action: "stock.adjust",
        entityType: "depot",
        entityId: input.depot,
        detail: { reason, gaps: gaps.filter((g) => g.gap !== 0) },
      });
      for (const [itemCode, was] of before) await checkThreshold(tx, ctx, itemCode, was);
    }
    return { applied: input.apply, gaps };
  });
}

/* ------------------------------------------------------------------ traçabilité (F6-6) */

/**
 * Patients concernés par un lot (rappel de lot) : délivrances sur ordonnance et consommations pour un patient.
 * La consultation est tracée dans l'audit.
 */
export async function lotTrace(db: Db, ctx: RequestContext, lotId: string) {
  return withTransaction(db, async (tx) => {
    const lot = await tx.query<{ item_code: string; lot_number: string; expires_on: string }>(
      "select item_code, lot_number, expires_on::text as expires_on from stock.lots where id = $1",
      [lotId],
    );
    const l = lot.rows[0];
    if (!l) throw notFound("Lot");
    const res = await tx.query<{
      patient_id: string;
      created_at: Date;
      quantity: number;
      kind: string;
      ref_type: string | null;
      ref_id: string | null;
      depot_code: string;
    }>(
      `select patient_id, created_at, -quantity as quantity, kind, ref_type, ref_id, depot_code
         from stock.movements where lot_id = $1 and patient_id is not null and kind in ('dispense', 'consume')
        order by created_at, id`,
      [lotId],
    );
    const people = await patientSummaries(tx, [...new Set(res.rows.map((r) => r.patient_id))]);
    await writeAudit(tx, ctx, {
      action: "stock.lot-trace",
      entityType: "lot",
      entityId: lotId,
      detail: { itemCode: l.item_code, lotNumber: l.lot_number, patients: res.rows.length },
    });
    return {
      lot: { id: lotId, itemCode: l.item_code, lotNumber: l.lot_number, expiresOn: l.expires_on },
      uses: res.rows.map((r) => ({
        at: r.created_at.toISOString(),
        kind: r.kind,
        quantity: r.quantity,
        refType: r.ref_type,
        refId: r.ref_id,
        depot: r.depot_code,
        patient: people.get(r.patient_id) ?? null,
      })),
    };
  });
}

/* ------------------------------------------------------------------ articles */

export interface Item {
  code: string;
  labelFr: string;
  labelAr: string | null;
  kind: ItemKind;
  unit: string;
  active: boolean;
}

interface ItemRow {
  code: string;
  label_fr: string;
  label_ar: string | null;
  kind: ItemKind;
  unit: string;
  active: boolean;
}
const toItem = (r: ItemRow): Item => ({
  code: r.code,
  labelFr: r.label_fr,
  labelAr: r.label_ar,
  kind: r.kind,
  unit: r.unit,
  active: r.active,
});

export async function requireItem(tx: Tx | Db, code: string): Promise<Item> {
  const res = await tx.query<ItemRow>(
    "select code, label_fr, label_ar, kind, unit, active from stock.items where code = $1",
    [code],
  );
  const row = res.rows[0];
  if (!row) throw notFound(`Article ${code}`);
  if (!row.active)
    throw new DomainError("item_inactive", `L'article ${code} n'est plus utilisé.`, 409);
  return toItem(row);
}

/** Familles d'articles qu'un rôle gère : la pharmacie les médicaments, le magasinier tout le reste. */
export function managedKinds(roles: readonly string[]): ItemKind[] {
  const kinds = new Set<ItemKind>();
  if (roles.includes("pharmacy")) kinds.add("drug");
  if (roles.includes("storekeeper"))
    for (const k of ["consumable", "reagent", "supply"] as const) kinds.add(k);
  return [...kinds];
}

export function assertCanManage(ctx: RequestContext, kind: ItemKind): void {
  if (!managedKinds(ctx.user.roles).includes(kind))
    throw new DomainError(
      "wrong_item_family",
      kind === "drug"
        ? "Les médicaments sont gérés par la pharmacie."
        : "Les consommables, réactifs et fournitures sont gérés par le magasin.",
      403,
    );
}

export async function listItems(
  db: Db,
  filter: { kind?: string | undefined; q?: string | undefined },
) {
  const res = await db.query<ItemRow>(
    `select code, label_fr, label_ar, kind, unit, active from stock.items
      where active and ($1::text is null or kind = $1)
        and ($2::text is null or code ilike $2 || '%' or unaccent(lower(label_fr)) like '%' || unaccent(lower($2)) || '%')
      order by kind, label_fr limit 300`,
    [filter.kind ?? null, filter.q?.trim() || null],
  );
  return res.rows.map(toItem);
}

const ITEM_HEADER = "code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj";
const FAMILIES: Record<string, ItemKind> = {
  consommable: "consumable",
  reactif: "reagent",
  fourniture: "supply",
};

export interface ItemImport {
  applied: boolean;
  total: number;
  imported: number;
  rejected: { line: number; code: string; errors: string[] }[];
}

/** Import des consommables, réactifs et fournitures (les médicaments viennent du catalogue des médicaments). */
export async function importItems(db: Db, ctx: RequestContext, csv: string): Promise<ItemImport> {
  const rows = parseCsv(csv);
  const header = (rows.shift() ?? []).map((c) => c.trim()).join(",");
  if (header !== ITEM_HEADER)
    throw new DomainError("bad_header", `En-tête attendu : ${ITEM_HEADER}`, 400);
  assertCanManage(ctx, "consumable");
  return withTransaction(db, async (tx) => {
    const report: ItemImport = { applied: true, total: rows.length, imported: 0, rejected: [] };
    const seen = new Set<string>();
    for (const [index, cells] of rows.entries()) {
      const [code, fr, ar, family, unit, responsible, updatedOn] = cells.map((c) => c.trim());
      const errors: string[] = [];
      if (!code) errors.push("code manquant");
      if (code && seen.has(code)) errors.push("code en double dans le fichier");
      if (!fr) errors.push("libellé français manquant");
      const kind = FAMILIES[(family ?? "").toLowerCase()];
      if (!kind) errors.push("famille : consommable, reactif ou fourniture");
      if (!unit) errors.push("unité manquante (ex. seringue, flacon, boîte)");
      if (!responsible) errors.push("responsable manquant");
      if (!updatedOn || !/^\d{4}-\d{2}-\d{2}$/.test(updatedOn))
        errors.push("date de mise à jour invalide");
      if (code) {
        const existing = await tx.query<{ kind: string }>(
          "select kind from stock.items where code = $1",
          [code],
        );
        if (existing.rows[0]?.kind === "drug")
          errors.push("ce code est un médicament : il se gère dans le catalogue des médicaments");
      }
      if (errors.length) {
        report.rejected.push({ line: index + 2, code: code ?? "", errors });
        continue;
      }
      seen.add(code as string);
      await tx.query(
        `insert into stock.items (code, label_fr, label_ar, kind, unit, responsible, updated_on)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (code) do update set label_fr = $2, label_ar = $3, kind = $4, unit = $5, responsible = $6, updated_on = $7, active = true`,
        [code, fr, ar || null, kind, unit, responsible, updatedOn],
      );
      report.imported += 1;
    }
    await writeAudit(tx, ctx, {
      action: "stock.items.import",
      entityType: "stock_items",
      detail: { total: report.total, imported: report.imported, rejected: report.rejected.length },
    });
    return report;
  });
}

/* ------------------------------------------------------------------ consommation */

interface FefoLot {
  lot_id: string;
  quantity: number;
}

/**
 * Sortie d'un article d'un dépôt, lot par lot (premier périmé, premier sorti), jamais un lot périmé.
 * `allowShortfall` : consomme ce qui existe et renvoie le manque (consommation d'un acte déjà réalisé) ;
 * sinon un stock insuffisant refuse tout.
 */
export async function consumeIn(
  tx: Tx,
  ctx: RequestContext,
  input: {
    depot: string;
    itemCode: string;
    quantity: number;
    kind: "consume" | "dispense";
    patientId?: string | null | undefined;
    refType: string;
    refId?: string | undefined;
    reason?: string | undefined;
    allowShortfall?: boolean;
  },
): Promise<{ consumed: number; missing: number; lots: { lotId: string; quantity: number }[] }> {
  const before = await usableTotal(tx, input.itemCode);
  const lots = await tx.query<FefoLot>(
    `select s.lot_id, s.quantity from stock.stock_levels s join stock.lots l on l.id = s.lot_id
      where s.depot_code = $1 and l.item_code = $2 and s.quantity > 0 and l.expires_on >= $3::date
      order by l.expires_on, l.lot_number, l.id for update of s`,
    [input.depot, input.itemCode, today()],
  );
  const available = lots.rows.reduce((n, r) => n + r.quantity, 0);
  if (available < input.quantity && !input.allowShortfall)
    throw new DomainError(
      "insufficient_stock",
      `Stock insuffisant pour ${input.itemCode} : ${available} disponible, ${input.quantity} demandé.`,
      409,
      { itemCode: input.itemCode, available, requested: input.quantity },
    );
  let need = Math.min(input.quantity, available);
  const used: { lotId: string; quantity: number }[] = [];
  for (const lot of lots.rows) {
    if (need === 0) break;
    const take = Math.min(need, lot.quantity);
    await move(tx, ctx, {
      depot: input.depot,
      lotId: lot.lot_id,
      quantity: -take,
      kind: input.kind,
      refType: input.refType,
      ...(input.refId ? { refId: input.refId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      patientId: input.patientId ?? null,
    });
    used.push({ lotId: lot.lot_id, quantity: take });
    need -= take;
  }
  const consumed = used.reduce((n, u) => n + u.quantity, 0);
  if (consumed > 0) await checkThreshold(tx, ctx, input.itemCode, before);
  return { consumed, missing: input.quantity - consumed, lots: used };
}

/** Utilisation de matériel hors acte (ex. seringues supplémentaires pendant une opération), tracée par patient si précisé. */
export async function consumeManual(
  db: Db,
  ctx: RequestContext,
  input: {
    depot: string;
    itemCode: string;
    quantity: number;
    patientId?: string | undefined;
    reason: string;
  },
) {
  return withTransaction(db, async (tx) => {
    await requireDepot(tx, input.depot);
    const item = await requireItem(tx, input.itemCode);
    if (input.patientId) {
      const p = await tx.query("select 1 from identity.patients where id = $1", [input.patientId]);
      if (!p.rowCount) throw notFound("Patient");
    }
    const r = await consumeIn(tx, ctx, { ...input, kind: "consume", refType: "manual" });
    await writeAudit(tx, ctx, {
      action: "stock.consume",
      entityType: "stock_item",
      entityId: item.code,
      patientId: input.patientId ?? null,
      detail: { depot: input.depot, quantity: input.quantity, reason: input.reason, lots: r.lots },
    });
    return { itemCode: item.code, consumed: r.consumed, lots: r.lots };
  });
}

/* ------------------------------------------------------------------ recettes d'actes */

export async function listRecipes(db: Db, actCode?: string) {
  const res = await db.query<{
    act_code: string;
    item_code: string;
    quantity: number;
    label_fr: string;
    unit: string;
    responsible: string;
    updated_on: string;
  }>(
    `select r.act_code, r.item_code, r.quantity, i.label_fr, i.unit, r.responsible, r.updated_on::text as updated_on
       from stock.act_recipes r join stock.items i on i.code = r.item_code
      where ($1::text is null or r.act_code = $1) order by r.act_code, i.label_fr`,
    [actCode ?? null],
  );
  return res.rows.map((r) => ({
    actCode: r.act_code,
    itemCode: r.item_code,
    labelFr: r.label_fr,
    unit: r.unit,
    quantity: r.quantity,
    responsible: r.responsible,
    updatedOn: r.updated_on,
  }));
}

/** Remplace la recette d'un acte : ce qu'il consomme chaque fois qu'il est réalisé. Responsable et date conservés. */
export async function setRecipe(
  db: Db,
  ctx: RequestContext,
  actCode: string,
  input: {
    items: { itemCode: string; quantity: number }[];
    responsible: string;
    updatedOn: string;
  },
) {
  return withTransaction(db, async (tx) => {
    const act = await tx.query("select 1 from catalog.acts where code = $1", [actCode]);
    if (!act.rowCount) throw notFound(`Acte ${actCode}`);
    const codes = input.items.map((i) => i.itemCode);
    if (new Set(codes).size !== codes.length)
      throw new DomainError("duplicate_item", "Un article figure deux fois dans la recette.", 400);
    for (const i of input.items) await requireItem(tx, i.itemCode);
    await tx.query("delete from stock.act_recipes where act_code = $1", [actCode]);
    for (const i of input.items)
      await tx.query(
        "insert into stock.act_recipes (act_code, item_code, quantity, responsible, updated_on) values ($1, $2, $3, $4, $5)",
        [actCode, i.itemCode, i.quantity, input.responsible, input.updatedOn],
      );
    await writeAudit(tx, ctx, {
      action: "stock.recipe",
      entityType: "act",
      entityId: actCode,
      detail: { items: input.items, responsible: input.responsible },
    });
    return { actCode, items: input.items.length };
  });
}

/**
 * Consommation d'un acte réalisé : la recette est prélevée dans le dépôt du service, premier périmé premier sorti.
 * L'acte est déjà fait : si le stock ne couvre pas, ce qui existe est prélevé et le manque est enregistré à régulariser.
 */
export async function consumeForAct(
  tx: Tx,
  ctx: RequestContext,
  input: {
    actCode: string;
    times: number;
    department: string;
    patientId: string | null;
    refType: string;
    refId: string;
  },
): Promise<{ consumed: number; shortfalls: number }> {
  const recipe = await tx.query<{ item_code: string; quantity: number }>(
    "select item_code, quantity from stock.act_recipes where act_code = $1 order by item_code",
    [input.actCode],
  );
  if (recipe.rows.length === 0) return { consumed: 0, shortfalls: 0 };
  const depot = await tx.query<{ code: string }>(
    "select code from stock.depots where serves_department = $1 and active",
    [input.department],
  );
  const depotCode = depot.rows[0]?.code;
  if (!depotCode) {
    await writeAudit(tx, ctx, {
      action: "stock.consume-skipped",
      entityType: "act",
      entityId: input.actCode,
      patientId: input.patientId,
      detail: {
        reason: "aucun dépôt de consommation pour ce service",
        department: input.department,
      },
    });
    return { consumed: 0, shortfalls: 0 };
  }
  let consumed = 0;
  let shortfalls = 0;
  for (const r of recipe.rows) {
    const need = r.quantity * input.times;
    const out = await consumeIn(tx, ctx, {
      depot: depotCode,
      itemCode: r.item_code,
      quantity: need,
      kind: "consume",
      patientId: input.patientId,
      refType: input.refType,
      refId: input.refId,
      reason: `acte ${input.actCode}`,
      allowShortfall: true,
    });
    consumed += out.consumed;
    if (out.missing > 0) {
      shortfalls += 1;
      await tx.query(
        `insert into stock.shortfalls (act_code, item_code, depot_code, missing, patient_id, ref_type, ref_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.actCode,
          r.item_code,
          depotCode,
          out.missing,
          input.patientId,
          input.refType,
          input.refId,
        ],
      );
    }
  }
  await writeAudit(tx, ctx, {
    action: "stock.consume-act",
    entityType: "act",
    entityId: input.actCode,
    patientId: input.patientId,
    detail: {
      times: input.times,
      depot: depotCode,
      refType: input.refType,
      refId: input.refId,
      shortfalls,
    },
  });
  return { consumed, shortfalls };
}

export async function listShortfalls(db: Db, open = true) {
  const res = await db.query<{
    id: string;
    act_code: string | null;
    item_code: string;
    label_fr: string;
    depot_code: string;
    missing: number;
    ref_type: string;
    ref_id: string | null;
    created_at: Date;
    resolved_at: Date | null;
    resolution: string | null;
  }>(
    `select s.id, s.act_code, s.item_code, i.label_fr, s.depot_code, s.missing, s.ref_type, s.ref_id, s.created_at, s.resolved_at, s.resolution
       from stock.shortfalls s join stock.items i on i.code = s.item_code
      where (not $1 or s.resolved_at is null) order by s.created_at desc limit 200`,
    [open],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    actCode: r.act_code,
    itemCode: r.item_code,
    labelFr: r.label_fr,
    depot: r.depot_code,
    missing: r.missing,
    refType: r.ref_type,
    refId: r.ref_id,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    resolution: r.resolution,
  }));
}

/** Régularisation d'un manque : après réception ou ajustement, avec explication écrite. */
export async function resolveShortfall(
  db: Db,
  ctx: RequestContext,
  id: number,
  resolution: string,
) {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<{ item_code: string; resolved_at: Date | null }>(
      "select s.item_code, s.resolved_at from stock.shortfalls s where s.id = $1 for update",
      [id],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Manque");
    if (row.resolved_at)
      throw new DomainError("already_resolved", "Ce manque est déjà régularisé.", 409);
    const item = await requireItem(tx, row.item_code);
    assertCanManage(ctx, item.kind);
    await tx.query(
      "update stock.shortfalls set resolved_at = now(), resolved_by = $2, resolution = $3 where id = $1",
      [id, ctx.user.id, resolution],
    );
    await writeAudit(tx, ctx, {
      action: "stock.shortfall.resolve",
      entityType: "shortfall",
      entityId: String(id),
      detail: { resolution },
    });
    return { id, resolved: true };
  });
}

/* ------------------------------------------------------------------ transferts entre dépôts */

export interface TransferInput {
  from: string;
  to: string;
  lines: { lotId: string; quantity: number }[];
  note?: string | undefined;
}

/** Transfert immédiat d'un dépôt à un autre (magasin central vers une réserve de service, par exemple). */
export async function transfer(db: Db, ctx: RequestContext, input: TransferInput) {
  if (input.from === input.to)
    throw new DomainError("same_depot", "Les deux dépôts sont identiques.", 400);
  return withTransaction(db, async (tx) => {
    await requireDepot(tx, input.from);
    await requireDepot(tx, input.to);
    const number = await nextNumber(tx, "stock", "transfer", "T");
    const moved: { lotId: string; itemCode: string; quantity: number }[] = [];
    for (const l of input.lines) {
      const lot = await tx.query<{ item_code: string; kind: ItemKind; expires_on: string }>(
        `select l.item_code, i.kind, l.expires_on::text as expires_on from stock.lots l join stock.items i on i.code = l.item_code where l.id = $1`,
        [l.lotId],
      );
      const row = lot.rows[0];
      if (!row) throw notFound("Lot");
      assertCanManage(ctx, row.kind);
      if (row.expires_on < today())
        throw new DomainError(
          "lot_expired",
          "Un lot périmé ne se transfère pas : retirez-le par un inventaire.",
          409,
        );
      await move(tx, ctx, {
        depot: input.from,
        lotId: l.lotId,
        quantity: -l.quantity,
        kind: "transfer_out",
        refType: "transfer",
        refId: number,
        ...(input.note ? { reason: input.note } : {}),
      });
      await move(tx, ctx, {
        depot: input.to,
        lotId: l.lotId,
        quantity: l.quantity,
        kind: "transfer_in",
        refType: "transfer",
        refId: number,
        ...(input.note ? { reason: input.note } : {}),
      });
      moved.push({ lotId: l.lotId, itemCode: row.item_code, quantity: l.quantity });
    }
    await writeAudit(tx, ctx, {
      action: "stock.transfer",
      entityType: "transfer",
      entityId: number,
      detail: { from: input.from, to: input.to, lines: moved },
    });
    return { number, from: input.from, to: input.to, lines: moved };
  });
}
