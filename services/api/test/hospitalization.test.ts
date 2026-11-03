import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { nightsSpent } from "../src/modules/hospitalization/service.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  ACTS_CSV,
  admitPatient,
  importCatalogs,
  makeCaller,
  newPatient,
  openCash,
  type Caller,
} from "./support/scenario.ts";

const EXTRA_ACTS = `HOSP-SOIN,Soins infirmiers du jour,رعاية تمريضية يومية,2000,HOSP,hospitalisation,Responsable test,2026-11-01
CHIR-INI,Opération initiale (exemple),عملية أولية,50000,HOSP,autre,Responsable test,2026-11-01
CHIR-GRD,Grande opération en cours de séjour (exemple),عملية كبرى,80000,HOSP,autre,Responsable test,2026-11-01
`;

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const DR = "dr-hosp";
const CASHIER = "caissier-hosp";
const NURSE = "inf-1";

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  const res = await call("admin", "POST", "/api/catalog/acts/import", ACTS_CSV + EXTRA_ACTS);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.rejected.length, 0, res.raw);
  await openCash(call, CASHIER);
});
after(async () => {
  await t.close();
  await db.drop();
});

const INITIAL = [
  { actCode: "HOSP-1J", quantity: 1 },
  { actCode: "CHIR-INI", quantity: 1 },
];

async function newStay(items = INITIAL) {
  const patient = await newPatient(call, "Hosp");
  const adm = await admitPatient(call, patient.id);
  const stay = await call(
    "doctor",
    "POST",
    "/api/stays",
    { patientId: patient.id, encounterId: adm.encounter.id, items },
    DR,
  );
  assert.equal(stay.status, 201, stay.raw);
  await t.dispatcher.drain();
  return {
    patient,
    encounterId: adm.encounter.id as string,
    stay: stay.body as { id: string; number: string; order: { id: string; number: string } },
  };
}

async function invoiceOf(orderNumber: string) {
  const res = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${orderNumber}`,
    undefined,
    CASHIER,
  );
  assert.equal(res.status, 200, res.raw);
  return res.body.invoices[0] as {
    id: string;
    patientAmount: number;
    amountDue: number;
    total: number;
    lines: unknown[];
  };
}
async function pay(invoiceId: string) {
  const res = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoiceId}/pay`,
    { method: "cash", receivedAmount: 1_000_000 },
    CASHIER,
  );
  assert.equal(res.status, 200, res.raw);
  await t.dispatcher.drain();
  return res.body;
}
async function paidStay(bed: string) {
  const s = await newStay();
  await pay((await invoiceOf(s.stay.order.number)).id);
  const adm = await call("nurse", "POST", `/api/stays/${s.stay.id}/admit`, { bedCode: bed }, NURSE);
  assert.equal(adm.status, 200, adm.raw);
  return s;
}
const setAdmittedDaysAgo = (stayId: string, days: number) =>
  db.owner.query(
    "update hosp.stays set admitted_at = now() - make_interval(days => $2) where id = $1",
    [stayId, days],
  );

test("nuitées : la première est dans le forfait, ensuite une par jour calendaire", () => {
  assert.equal(nightsSpent("2026-11-03", "2026-11-03"), 1);
  assert.equal(nightsSpent("2026-11-03", "2026-11-04"), 1);
  assert.equal(nightsSpent("2026-11-03", "2026-11-05"), 2);
  assert.equal(nightsSpent("2026-11-03", "2026-11-08"), 5);
});

test("forfait initial : première nuit et acte initial payés d'abord, avec ou sans remise, puis entrée au lit", async () => {
  const none = await call(
    "doctor",
    "POST",
    "/api/stays",
    {
      patientId: "00000000-0000-4000-8000-000000000000",
      encounterId: "00000000-0000-4000-8000-000000000000",
      items: [{ actCode: "CHIR-INI", quantity: 1 }],
    },
    DR,
  );
  assert.equal(none.body.error.code, "first_night_required");
  const twice = await call(
    "doctor",
    "POST",
    "/api/stays",
    {
      patientId: "00000000-0000-4000-8000-000000000000",
      encounterId: "00000000-0000-4000-8000-000000000000",
      items: [{ actCode: "HOSP-1J", quantity: 2 }],
    },
    DR,
  );
  assert.equal(twice.body.error.code, "first_night_required");

  const s = await newStay();
  assert.match(s.stay.number, /^H-\d{6}$/);
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        "/api/stays",
        { patientId: s.patient.id, encounterId: s.encounterId, items: INITIAL },
        DR,
      )
    ).body.error.code,
    "stay_already_open",
  );

  // Avant le paiement : pas d'entrée au lit, pas de ticket.
  const early = await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/admit`,
    { bedCode: "MED-01" },
    NURSE,
  );
  assert.equal(early.body.error.code, "payment_required");
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int n from orders.department_tickets where order_id = $1",
        [s.stay.order.id],
      )
    ).rows[0].n,
    0,
  );

  // Remise : la caisse jusqu'au plafond, la direction au-delà ; jamais le médecin.
  const inv = await invoiceOf(s.stay.order.number);
  assert.equal(inv.total, 60000);
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/billing/invoices/${inv.id}/discount`,
        { percent: 5, reason: "essai" },
        DR,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/invoices/${inv.id}/discount`,
        { percent: 5, amount: 100, reason: "essai" },
        CASHIER,
      )
    ).body.error.code,
    "percent_or_amount",
  );
  const big = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.id}/discount`,
    { percent: 30, reason: "Patient indigent" },
    CASHIER,
  );
  assert.equal(big.status, 403);
  assert.equal(big.body.error.code, "discount_needs_direction");
  const small = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.id}/discount`,
    { percent: 10, reason: "Personnel du CHU" },
    CASHIER,
  );
  assert.equal(small.status, 200, small.raw);
  assert.equal(small.body.amountDue, 54000);
  const dir = await call(
    "direction",
    "POST",
    `/api/billing/invoices/${inv.id}/discount`,
    { percent: 30, reason: "Patient indigent, accord de la direction" },
    "directeur-1",
  );
  assert.equal(dir.status, 200, dir.raw);
  assert.deepEqual(
    [dir.body.patientAmount, dir.body.amountDue, dir.body.discount.amount, dir.body.discount.by],
    [60000, 42000, 18000, "directeur-1"],
  );
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/invoices/${inv.id}/discount`,
        { amount: 99999999, reason: "trop" },
        CASHIER,
      )
    ).body.error.code,
    "discount_too_large",
  );

  const paid = await pay(inv.id);
  assert.equal(paid.payment.amount, 42000, "le patient paie le montant remisé");
  const receipt = await call(
    "cashier",
    "GET",
    `/api/billing/invoices/${inv.id}/receipt`,
    undefined,
    CASHIER,
  );
  assert.equal(receipt.body.discount.amount, 18000);
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/invoices/${inv.id}/discount`,
        { percent: 1, reason: "après coup" },
        CASHIER,
      )
    ).body.error.code,
    "discount_not_allowed",
  );
  await assert.rejects(
    db.owner.query(
      "update billing.invoices set discount_amount = 0, discount_by = null, discount_reason = null where id = $1",
      [inv.id],
    ),
    /ne se modifie plus/,
  );
  assert.equal(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'invoice.discount' and entity_id = $1",
        [inv.id],
      )
    ).rowCount,
    2,
  );

  const adm = await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/admit`,
    { bedCode: "MED-01" },
    NURSE,
  );
  assert.equal(adm.status, 200, adm.raw);
  assert.equal(adm.body.status, "admitted");
  const tk = await db.owner.query(
    "select status, started_by from orders.department_tickets where order_id = $1 and department_code = 'HOSP'",
    [s.stay.order.id],
  );
  assert.deepEqual([tk.rows[0].status, tk.rows[0].started_by], ["in_progress", NURSE]);
  assert.equal(
    (
      await db.owner.query(
        "select 1 from events.outbox where type = 'StayAdmitted' and payload->>'stayId' = $1",
        [s.stay.id],
      )
    ).rowCount,
    1,
  );

  const beds = await call("nurse", "GET", "/api/beds", undefined, NURSE);
  assert.equal(beds.body.beds.find((b: { code: string }) => b.code === "MED-01").occupied, true);
  const other = await newStay();
  await pay((await invoiceOf(other.stay.order.number)).id);
  assert.equal(
    (await call("nurse", "POST", `/api/stays/${other.stay.id}/admit`, { bedCode: "MED-01" }, NURSE))
      .body.error.code,
    "bed_occupied",
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${other.stay.id}/admit`,
        { bedCode: "INCONNU" },
        NURSE,
      )
    ).body.error.code,
    "unknown_bed",
  );
  assert.equal(
    (await call("doctor", "POST", `/api/stays/${other.stay.id}/admit`, { bedCode: "MED-02" }, DR))
      .status,
    403,
    "l'entrée au lit est faite par le service",
  );
  assert.equal(
    (await call("nurse", "POST", `/api/stays/${other.stay.id}/admit`, { bedCode: "MED-02" }, NURSE))
      .status,
    200,
  );
});

test("pendant le séjour : soins courants à la sortie, grandes opérations payées à part avant exécution", async () => {
  const s = await paidStay("MED-03");
  const care = await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/charges`,
    { actCode: "HOSP-SOIN", quantity: 2 },
    NURSE,
  );
  assert.equal(care.status, 201, care.raw);
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${s.stay.id}/charges`,
        { actCode: "CHIR-GRD", quantity: 1 },
        NURSE,
      )
    ).body.error.code,
    "must_be_ordered",
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${s.stay.id}/charges`,
        { actCode: "LAB-GLY", quantity: 1 },
        NURSE,
      )
    ).body.error.code,
    "must_be_ordered",
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${s.stay.id}/charges`,
        { actCode: "HOSP-1J", quantity: 1 },
        NURSE,
      )
    ).body.error.code,
    "nights_accrue",
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${s.stay.id}/orders`,
        { items: [{ actCode: "HOSP-1J", quantity: 1 }] },
        NURSE,
      )
    ).body.error.code,
    "nights_accrue",
  );

  // Grande opération : demande à part, facture à la caisse, ticket seulement après paiement.
  const op = await call(
    "doctor",
    "POST",
    `/api/stays/${s.stay.id}/orders`,
    { items: [{ actCode: "CHIR-GRD", quantity: 1 }], note: "Intervention urgente" },
    DR,
  );
  assert.equal(op.status, 201, op.raw);
  await t.dispatcher.drain();
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int n from orders.department_tickets where order_id = $1",
        [op.body.id],
      )
    ).rows[0].n,
    0,
    "pas de ticket avant paiement",
  );
  const inv = await invoiceOf(op.body.number);
  assert.equal(inv.total, 80000);
  await pay(inv.id);
  const tickets = await call(
    "nurse",
    "GET",
    "/api/department-tickets?department=HOSP&status=sent",
    undefined,
    NURSE,
  );
  assert.ok(
    tickets.body.tickets.some((x: { orderNumber: string }) => x.orderNumber === op.body.number),
    "ticket libéré après paiement",
  );
  const view = await call("nurse", "GET", `/api/stays/${s.stay.id}`, undefined, NURSE);
  assert.deepEqual(
    view.body.orders.map((o: { kind: string; status: string }) => [o.kind, o.status]),
    [
      ["initial", "released"],
      ["extra", "released"],
    ],
  );
  assert.equal(view.body.projected.careAmount, 4000);
  assert.equal(view.body.projected.nights, 1);
});

test("sortie : nuitées et soins sur la facture de sortie, payée à la caisse avant le départ", async () => {
  const s = await paidStay("CHIR-01");
  await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/charges`,
    { actCode: "HOSP-SOIN", quantity: 2 },
    NURSE,
  );
  await setAdmittedDaysAgo(s.stay.id, 4); // 4 nuits : 1 dans le forfait, 3 à facturer
  const proj = await call("nurse", "GET", `/api/stays/${s.stay.id}`, undefined, NURSE);
  assert.deepEqual(
    [proj.body.projected.nights, proj.body.projected.extraNights, proj.body.projected.total],
    [4, 3, 3 * 10000 + 4000],
  );

  // Une demande impayée bloque la sortie.
  const op = await call(
    "doctor",
    "POST",
    `/api/stays/${s.stay.id}/orders`,
    { items: [{ actCode: "LAB-GLY", quantity: 1 }] },
    DR,
  );
  await t.dispatcher.drain();
  const blocked = await call("doctor", "POST", `/api/stays/${s.stay.id}/discharge`, {}, DR);
  assert.equal(blocked.body.error.code, "orders_unpaid");
  assert.deepEqual(blocked.body.error.details.orders, [op.body.number]);
  await pay((await invoiceOf(op.body.number)).id);

  assert.equal(
    (await call("nurse", "POST", `/api/stays/${s.stay.id}/discharge`, {}, NURSE)).status,
    403,
    "l'ordre de sortie est médical",
  );
  const out = await call("doctor", "POST", `/api/stays/${s.stay.id}/discharge`, {}, DR);
  assert.equal(out.status, 200, out.raw);
  assert.equal(out.body.status, "discharge_pending");
  assert.equal(out.body.nights, 4);
  await t.dispatcher.drain();

  const final = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${s.stay.number}`,
    undefined,
    CASHIER,
  );
  const fi = (
    await call(
      "cashier",
      "GET",
      `/api/billing/invoices/${final.body.invoices[0].id}`,
      undefined,
      CASHIER,
    )
  ).body;
  assert.equal(fi.total, 34000);
  assert.deepEqual(
    fi.lines
      .map((l: { actCode: string; quantity: number; lineTotal: number }) => [
        l.actCode,
        l.quantity,
        l.lineTotal,
      ])
      .sort(),
    [
      ["HOSP-1J", 3, 30000],
      ["HOSP-SOIN", 2, 4000],
    ],
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${s.stay.id}/charges`,
        { actCode: "HOSP-SOIN", quantity: 1 },
        NURSE,
      )
    ).body.error.code,
    "stay_not_admitted",
  );

  // Le patient ne part pas avant d'avoir payé.
  const early = await call("nurse", "POST", `/api/stays/${s.stay.id}/exit`, {}, NURSE);
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, "final_invoice_unpaid");
  assert.equal(early.body.error.details.amountDue, 34000);
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/invoices/${fi.id}/discount`,
        { percent: 10, reason: "Geste commercial" },
        CASHIER,
      )
    ).body.amountDue,
    30600,
  );
  const paid = await pay(fi.id);
  assert.equal(paid.payment.amount, 30600);

  const exit = await call("nurse", "POST", `/api/stays/${s.stay.id}/exit`, {}, NURSE);
  assert.equal(exit.status, 200, exit.raw);
  assert.equal(exit.body.status, "discharged");
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'StayDischarged' and payload->>'stayId' = $1",
    [s.stay.id],
  );
  assert.deepEqual(
    [ev.rows[0].payload.nights, ev.rows[0].payload.exitedUnpaid, ev.rows[0].payload.finalInvoiceId],
    [4, false, fi.id],
  );
  const tk = await db.owner.query(
    "select status, completed_by from orders.department_tickets where order_id = $1 and department_code = 'HOSP'",
    [s.stay.order.id],
  );
  assert.deepEqual([tk.rows[0].status, tk.rows[0].completed_by], ["completed", NURSE]);
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int n from hosp.charges where stay_id = $1 and invoice_id is not null",
        [s.stay.id],
      )
    ).rows[0].n,
    4,
    "3 nuits et 1 soin facturés",
  );
  await assert.rejects(
    db.owner.query("update hosp.charges set quantity = 9 where stay_id = $1", [s.stay.id]),
    /ne se modifie pas/,
  );
  await assert.rejects(
    db.owner.query("delete from hosp.charges where stay_id = $1", [s.stay.id]),
    /ne se supprime pas/,
  );

  // Le lit est libéré.
  const again = await paidStay("CHIR-01");
  assert.ok(again.stay.id);
});

test("sortie le jour même sans soin : rien d'autre à facturer ; sortie impayée seulement par la direction, avec motif", async () => {
  const quick = await paidStay("CHIR-02");
  const out = await call("doctor", "POST", `/api/stays/${quick.stay.id}/discharge`, {}, DR);
  assert.equal(out.body.finalInvoiceId, null);
  assert.equal(out.body.nights, 1);
  assert.equal(
    (await call("nurse", "POST", `/api/stays/${quick.stay.id}/exit`, {}, NURSE)).status,
    200,
    "pas de facture de sortie : le patient peut partir",
  );

  const s = await paidStay("CHIR-02");
  await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/charges`,
    { actCode: "HOSP-SOIN", quantity: 3 },
    NURSE,
  );
  await call("doctor", "POST", `/api/stays/${s.stay.id}/discharge`, {}, DR);
  await t.dispatcher.drain();
  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${s.stay.number}`,
    undefined,
    CASHIER,
  );
  assert.equal(inv.body.invoices[0].total, 6000);

  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        `/api/stays/${s.stay.id}/exit`,
        { unpaidReason: "le patient insiste pour partir" },
        NURSE,
      )
    ).body.error.code,
    "final_invoice_unpaid",
    "le service ne peut pas contourner la caisse",
  );
  assert.equal(
    (await call("direction", "POST", `/api/stays/${s.stay.id}/exit`, {}, "directeur-1")).body.error
      .code,
    "unpaid_reason_required",
  );
  assert.equal(
    (
      await call(
        "direction",
        "POST",
        `/api/stays/${s.stay.id}/exit`,
        { unpaidReason: "non" },
        "directeur-1",
      )
    ).status,
    400,
  );
  const ok = await call(
    "direction",
    "POST",
    `/api/stays/${s.stay.id}/exit`,
    { unpaidReason: "Famille sans ressources, engagement écrit" },
    "directeur-1",
  );
  assert.equal(ok.status, 200, ok.raw);
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'StayDischarged' and payload->>'stayId' = $1",
    [s.stay.id],
  );
  assert.equal(ev.rows[0].payload.exitedUnpaid, true);
  assert.equal(ev.rows[0].payload.exitedBy.userId, "directeur-1");
  const audit = await db.owner.query(
    "select detail from audit.log where action = 'stay.exit' and entity_id = $1",
    [s.stay.id],
  );
  assert.equal(audit.rows[0].detail.reason, "Famille sans ressources, engagement écrit");
  assert.equal(
    (
      await db.owner.query("select status from billing.invoices where order_number = $1", [
        s.stay.number,
      ])
    ).rows[0].status,
    "pending",
    "la dette reste visible à la caisse",
  );
});

test("soins courants : la recette de l'acte (seringues, compresses) est prélevée dans la réserve d'hospitalisation, pour le patient", async () => {
  await call("admin", "POST", "/api/beds", { code: "TST-1", ward: "Test", label: "Lit de test" });
  const keeper = "magasinier-hosp";
  await call(
    "storekeeper",
    "POST",
    "/api/stock/items/import",
    `code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj\nSYR-H,Seringue,محقنة,consommable,seringue,Magasinier test,2026-11-01\nCOMP-H,Compresse stérile,ضمادة,consommable,sachet,Magasinier test,2026-11-01\n`,
    keeper,
  );
  const expires = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
  for (const [code, qty] of [
    ["SYR-H", 10],
    ["COMP-H", 4],
  ] as const) {
    const r = await call(
      "storekeeper",
      "POST",
      "/api/stock/receipts",
      {
        depot: "HOSP",
        lines: [{ itemCode: code, lotNumber: `L-${code}`, expiresOn: expires, quantity: qty }],
      },
      keeper,
    );
    assert.equal(r.status, 201, r.raw);
  }
  assert.equal(
    (
      await call(
        "storekeeper",
        "PUT",
        "/api/stock/recipes/HOSP-SOIN",
        {
          items: [
            { itemCode: "SYR-H", quantity: 2 },
            { itemCode: "COMP-H", quantity: 1 },
          ],
          responsible: "Cadre infirmier test",
          updatedOn: "2026-11-01",
        },
        keeper,
      )
    ).status,
    200,
  );

  const s = await paidStay("TST-1");
  const care = await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/charges`,
    { actCode: "HOSP-SOIN", quantity: 3 },
    NURSE,
  );
  assert.equal(care.status, 201, care.raw);
  const used = await db.owner.query(
    "select l.item_code, -m.quantity as q, m.patient_id, m.ref_id from stock.movements m join stock.lots l on l.id = m.lot_id where m.kind = 'consume' and m.ref_type = 'stay' order by l.item_code",
  );
  assert.deepEqual(
    used.rows.map((r) => [r.item_code, r.q]),
    [
      ["COMP-H", 3],
      ["SYR-H", 6],
    ],
    "3 soins consomment 6 seringues et 3 compresses",
  );
  assert.ok(used.rows.every((r) => r.patient_id === s.patient.id && r.ref_id === s.stay.number));

  // Stock insuffisant : le soin est enregistré, le manque est signalé (le soin est déjà donné).
  const more = await call(
    "nurse",
    "POST",
    `/api/stays/${s.stay.id}/charges`,
    { actCode: "HOSP-SOIN", quantity: 3 },
    NURSE,
  );
  assert.equal(more.status, 201, more.raw);
  const gaps = await call("storekeeper", "GET", "/api/stock/shortfalls", undefined, keeper);
  assert.deepEqual(
    gaps.body.shortfalls
      .map((g: { itemCode: string; missing: number }) => [g.itemCode, g.missing])
      .sort(),
    [
      ["COMP-H", 2],
      ["SYR-H", 2],
    ],
  );
});
