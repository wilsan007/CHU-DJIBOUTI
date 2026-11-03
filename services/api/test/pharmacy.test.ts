import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  importCatalogs,
  importClinicalCatalogs,
  makeCaller,
  startConsultation,
  type Caller,
} from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const DR1 = "dr-1";

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  await importClinicalCatalogs(call);
});
after(async () => {
  await t.close();
  await db.drop();
});

/** Date locale (Djibouti, UTC+3) décalée de `n` jours. */
const day = (n: number): string =>
  new Date(Date.now() + 3 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

async function stockIn(
  drugCode: string,
  lotNumber: string,
  expiresOn: string,
  quantity: number,
  depot = "PC",
) {
  const res = await call("pharmacy", "POST", "/api/stock/receipts", {
    depot,
    lines: [{ itemCode: drugCode, lotNumber, expiresOn, quantity }],
  });
  assert.equal(res.status, 201, res.raw);
}

async function prescription(drugCode: string, dose: number, perDay: number, days: number) {
  const c = await startConsultation(call, DR1, `Pharma${Math.random().toString(36).slice(2, 7)}`);
  const res = await call(
    "doctor",
    "POST",
    "/api/prescriptions",
    {
      patientId: c.patient.id,
      consultationId: c.consultation.id,
      lines: [{ drugCode, dose, perDay, days, route: "oral" }],
      overrides: [],
    },
    DR1,
  );
  assert.equal(res.status, 201, res.raw);
  return {
    id: res.body.id as string,
    patientId: c.patient.id,
    quantity: res.body.lines[0].quantity as number,
  };
}

const level = async (drugCode: string): Promise<number> =>
  Number(
    (
      await db.owner.query(
        `select coalesce(sum(s.quantity), 0) as n from stock.stock_levels s join stock.lots l on l.id = s.lot_id where l.item_code = $1`,
        [drugCode],
      )
    ).rows[0].n,
  );

test("F6-4 : réception avec lot et péremption, contrôle de la quantité commandée", async () => {
  const order = await call("pharmacy", "POST", "/api/stock/orders", {
    supplier: "Fournisseur test",
    lines: [{ itemCode: "AZI-250", quantity: 100 }],
  });
  assert.equal(order.status, 201, order.raw);
  assert.match(order.body.number, /^CMD-\d{6}$/);

  const bad = (lines: unknown[], orderId = order.body.id) =>
    call("pharmacy", "POST", "/api/stock/receipts", { depot: "PC", orderId, lines });
  const line = (over: Record<string, unknown> = {}) => ({
    itemCode: "AZI-250",
    lotNumber: "L-A1",
    expiresOn: day(400),
    quantity: 60,
    ...over,
  });

  assert.equal((await bad([line({ lotNumber: "" })])).status, 400, "lot obligatoire");
  assert.equal((await bad([line({ expiresOn: "" })])).status, 400, "péremption obligatoire");
  assert.equal((await bad([line({ expiresOn: day(-1) })])).body.error.code, "already_expired");
  assert.equal((await bad([line({ itemCode: "PAR-500" })])).body.error.code, "not_ordered");

  const first = await bad([line()]);
  assert.equal(first.status, 201, first.raw);
  assert.equal(first.body.order.status, "partially_received");
  const over = await bad([line({ lotNumber: "L-A2", quantity: 41 })]);
  assert.equal(over.body.error.code, "over_receipt");
  const mismatch = await bad([line({ expiresOn: day(500), quantity: 10 })]);
  assert.equal(mismatch.body.error.code, "lot_expiry_mismatch");
  assert.equal(await level("AZI-250"), 60, "les réceptions refusées n'ont rien changé");

  const rest = await bad([line({ lotNumber: "L-A2", expiresOn: day(300), quantity: 40 })]);
  assert.equal(rest.body.order.status, "received");
  assert.equal((await bad([line({ quantity: 1 })])).body.error.code, "order_closed");

  assert.equal((await call("doctor", "POST", "/api/stock/receipts", {})).status, 403);
  assert.equal((await call("cashier", "GET", "/api/stock/levels")).status, 403);
});

test("F6-2 : délivrance premier périmé premier sorti, partielle puis complète, événement publié", async () => {
  await stockIn("MET-500", "M-LATE", day(500), 100);
  await stockIn("MET-500", "M-SOON", day(200), 20);
  await stockIn("MET-500", "M-OLD", day(-5), 50).catch(() => null);
  const rx = await prescription("MET-500", 1, 2, 30); // 60 comprimés
  assert.equal(rx.quantity, 60);

  const partial = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
    lines: [{ lineNo: 1, quantity: 30 }],
  });
  assert.equal(partial.status, 201, partial.raw);
  assert.equal(partial.body.prescriptionStatus, "partially_dispensed");
  assert.deepEqual(
    partial.body.lines.map((l: { lotNumber: string; quantity: number }) => [
      l.lotNumber,
      l.quantity,
    ]),
    [
      ["M-SOON", 20],
      ["M-LATE", 10],
    ],
    "le lot qui périme le plus tôt part d'abord",
  );
  const status = await call("pharmacy", "GET", `/api/pharmacy/prescriptions/${rx.id}`);
  assert.equal(status.body.lines[0].remaining, 30);

  const tooMuch = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
    lines: [{ lineNo: 1, quantity: 31 }],
  });
  assert.equal(tooMuch.body.error.code, "exceeds_prescription");

  const rest = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
  });
  assert.equal(rest.status, 201, rest.raw);
  assert.equal(rest.body.prescriptionStatus, "dispensed");
  assert.equal(await level("MET-500"), 60);
  assert.equal(
    (
      await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
        prescriptionId: rx.id,
        depot: "PC",
      })
    ).body.error.code,
    "already_dispensed",
  );
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'MedicationDispensed' and payload->>'prescriptionId' = $1 order by id",
    [rx.id],
  );
  assert.deepEqual(
    ev.rows.map((r) => r.payload.prescriptionStatus),
    ["partially_dispensed", "dispensed"],
  );
  assert.match(rest.body.number, /^D-\d{6}$/);
  const audit = await db.owner.query(
    "select 1 from audit.log where action = 'pharmacy.dispense' and entity_id = $1",
    [rx.id],
  );
  assert.equal(audit.rowCount, 2);
});

test("F6-2 : stock insuffisant ou lot périmé, tout est annulé ; ordonnance remplacée refusée", async () => {
  await stockIn("IBU-400", "I-OK", day(60), 5);
  const rx = await prescription("IBU-400", 1, 3, 5); // 15
  const short = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
  });
  assert.equal(short.status, 409);
  assert.equal(short.body.error.code, "insufficient_stock");
  assert.equal(short.body.error.details.available, 5);
  assert.equal(
    (
      await db.owner.query(
        "select count(*) n from pharmacy.dispensations where prescription_id = $1",
        [rx.id],
      )
    ).rows[0].n,
    "0",
  );
  assert.equal(
    (await db.owner.query("select status from prescriptions.prescriptions where id = $1", [rx.id]))
      .rows[0].status,
    "pending",
  );

  // Lot périmé en base (inséré par le propriétaire) : jamais servi.
  const lot = await db.owner.query(
    "insert into stock.lots (item_code, lot_number, expires_on) values ('IBU-400', 'I-DEAD', $1) returning id",
    [day(-3)],
  );
  await db.owner.query(
    "insert into stock.stock_levels (depot_code, lot_id, quantity) values ('PC', $1, 500)",
    [lot.rows[0].id],
  );
  const still = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
  });
  assert.equal(still.body.error.code, "insufficient_stock", "le lot périmé ne compte pas");

  const rev = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.id}/revise`,
    {
      lines: [{ drugCode: "IBU-400", dose: 1, perDay: 1, days: 3, route: "oral" }],
      overrides: [],
      reason: "dose réduite",
    },
    DR1,
  );
  assert.equal(rev.status, 201, rev.raw);
  const old = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
  });
  assert.equal(old.body.error.code, "prescription_superseded");
  assert.equal(old.body.error.details.currentId, rev.body.prescription.id);
  const ok = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rev.body.prescription.id,
    depot: "PC",
  });
  assert.equal(ok.status, 201, ok.raw);
  assert.equal(await level("IBU-400"), 500 + 2, "5 - 3 en stock utilisable, plus le lot périmé");
});

test("deux délivrances simultanées de la même ordonnance : une seule réussit, le stock reste juste", async () => {
  await stockIn("PAR-500", "P-1", day(300), 100);
  const rx = await prescription("PAR-500", 1, 3, 3); // 9
  const body = { prescriptionId: rx.id, depot: "PC" };
  const [a, b] = await Promise.all([
    call("pharmacy", "POST", "/api/pharmacy/dispensations", body),
    call("pharmacy", "POST", "/api/pharmacy/dispensations", body),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(await level("PAR-500"), 91);
});

test("F6-3 : alerte de rupture publiée une seule fois au franchissement ; péremptions proches signalées", async () => {
  await stockIn("WAR-5", "W-1", day(30), 20);
  await stockIn("WAR-5", "W-2", day(400), 10);
  const th = await call("pharmacy", "PUT", "/api/stock/thresholds/WAR-5", { minimum: 25 });
  assert.equal(th.status, 200, th.raw);
  const rx = await prescription("WAR-5", 1, 1, 10);
  const dispense = () =>
    call("pharmacy", "POST", "/api/pharmacy/dispensations", {
      prescriptionId: rx.id,
      depot: "PC",
      lines: [{ lineNo: 1, quantity: 2 }],
    });
  assert.equal((await dispense()).status, 201); // 30 -> 28
  assert.equal(
    (
      await db.owner.query(
        "select count(*) n from events.outbox where type = 'StockBelowThreshold'",
      )
    ).rows[0].n,
    "0",
  );
  assert.equal((await dispense()).status, 201);
  assert.equal((await dispense()).status, 201);
  assert.equal((await dispense()).status, 201); // 22 : franchissement
  const rx2 = await prescription("WAR-5", 1, 1, 10);
  await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx2.id,
    depot: "PC",
    lines: [{ lineNo: 1, quantity: 1 }],
  });
  const events = await db.owner.query(
    "select payload from events.outbox where type = 'StockBelowThreshold'",
  );
  assert.equal(events.rowCount, 1, "une seule alerte");
  assert.equal(events.rows[0].payload.itemCode, "WAR-5");
  assert.equal(events.rows[0].payload.minimum, 25);

  const a = await call("pharmacy", "GET", "/api/stock/alerts");
  assert.equal(a.status, 200, a.raw);
  assert.ok(a.body.belowThreshold.some((x: { itemCode: string }) => x.itemCode === "WAR-5"));
  assert.ok(
    a.body.expiry.some(
      (x: { lotNumber: string; status: string }) =>
        x.lotNumber === "W-1" && x.status === "expiring",
    ),
  );
  assert.ok(!a.body.expiry.some((x: { lotNumber: string }) => x.lotNumber === "W-2"));
});

test("F6-5 : inventaire, écarts calculés, motif obligatoire, ajustement tracé, journal non modifiable", async () => {
  await stockIn("AMO-500", "AM-1", day(200), 50);
  const stock = await call("pharmacy", "GET", "/api/stock/levels?itemCode=AMO-500");
  const lotId = stock.body.lots[0].lotId as string;
  const counts = [{ lotId, counted: 47 }];
  const preview = await call("pharmacy", "POST", "/api/stock/inventory", {
    depot: "PC",
    counts,
    apply: false,
  });
  assert.equal(preview.body.gaps[0].gap, -3);
  assert.equal(await level("AMO-500"), 50, "l'aperçu ne modifie rien");

  const noReason = await call("pharmacy", "POST", "/api/stock/inventory", {
    depot: "PC",
    counts,
    apply: true,
  });
  assert.equal(noReason.body.error.code, "reason_required");
  const applied = await call("pharmacy", "POST", "/api/stock/inventory", {
    depot: "PC",
    counts,
    reason: "Casse constatée au comptage",
    apply: true,
  });
  assert.equal(applied.status, 200, applied.raw);
  assert.equal(await level("AMO-500"), 47);
  const mv = await db.owner.query(
    "select kind, quantity, reason, user_id from stock.movements where lot_id = $1 order by id",
    [lotId],
  );
  assert.deepEqual(
    mv.rows.map((r) => [r.kind, r.quantity]),
    [
      ["receipt", 50],
      ["adjustment", -3],
    ],
  );
  assert.equal(mv.rows[1].reason, "Casse constatée au comptage");
  assert.ok(mv.rows[1].user_id);
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'stock.adjust'")).rowCount,
    1,
  );

  await assert.rejects(
    db.owner.query("update stock.movements set quantity = 1 where lot_id = $1", [lotId]),
    /ne se modifie ni ne se supprime/,
  );
  await assert.rejects(
    db.owner.query("delete from stock.movements where lot_id = $1", [lotId]),
    /ne se modifie ni ne se supprime/,
  );
  await assert.rejects(
    db.owner.query("update stock.stock_levels set quantity = -1 where lot_id = $1", [lotId]),
    /check/i,
  );
  await assert.rejects(
    db.app.query("update pharmacy.dispensation_lines set quantity = 1"),
    /permission denied|ne se modifie/,
  );
});

test("F6-6 : liste des patients concernés par un lot en moins de 10 secondes, consultation tracée", async () => {
  await stockIn("AZI-250", "TR-1", day(250), 30);
  const rx = await prescription("AZI-250", 2, 1, 5);
  const served = await call("pharmacy", "POST", "/api/pharmacy/dispensations", {
    prescriptionId: rx.id,
    depot: "PC",
  });
  assert.equal(served.status, 201, served.raw);
  const lotId = (await db.owner.query("select id from stock.lots where lot_number = 'TR-1'"))
    .rows[0].id as string;

  // 30 000 sorties fictives pour des patients sur ce lot (insertion directe par le propriétaire).
  await db.owner.query(
    `insert into stock.movements (depot_code, lot_id, quantity, kind, ref_type, ref_id, user_id, patient_id)
     select 'PC', $1, -1, 'dispense', 'dispensation', 'DX-' || g, 'x', $2 from generate_series(1, 30000) g`,
    [lotId, rx.patientId],
  );
  const started = Date.now();
  const res = await call("pharmacy", "GET", `/api/stock/lots/${lotId}/patients`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.uses.length, 30001);
  assert.ok(res.body.uses[0].patient.name);
  assert.ok(elapsed < 10_000, `trop lent : ${elapsed} ms`);
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'stock.lot-trace'")).rowCount,
    1,
  );
  assert.equal((await call("doctor", "GET", `/api/stock/lots/${lotId}/patients`)).status, 403);
});
