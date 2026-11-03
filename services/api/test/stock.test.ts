import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cardPayload } from "../src/modules/identity/card.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  importClinicalCatalogs,
  makeCaller,
  newPatient,
  openCash,
  type Caller,
} from "./support/scenario.ts";

const ITEMS_CSV = `code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj
SYR-5,Seringue 5 ml,محقنة 5 مل,consommable,seringue,Magasinier test,2026-11-01
REA-GLY,Réactif glycémie,كاشف سكر الدم,reactif,test,Biologiste test,2026-11-01
FILM-35,Film radiologique 35x43,فيلم,fourniture,film,Radiologue test,2026-11-01
CONTR,Produit de contraste,مادة التباين,consommable,flacon,Radiologue test,2026-11-01
`;
const LAB_TESTS_CSV = `code,loinc,act_code,libelle_fr,libelle_ar,echantillon,unite,type_valeur,responsable,date_maj
GLY,2345-7,LAB-GLY,Glycémie,سكر الدم,Sérum,mmol/L,numeric,Biologiste test,2026-11-01
`;

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const KEEPER = "magasinier-1";
const CASHIER = "caissier-stock";
const DR = "dr-stock";
const TECH = "tech-stock";
const BIO = "bio-stock";
const IMG = "img-stock";
const exp = (days: number) =>
  new Date(Date.now() + 3 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  await importClinicalCatalogs(call);
  await openCash(call, CASHIER);
  const imp = await call("storekeeper", "POST", "/api/stock/items/import", ITEMS_CSV, KEEPER);
  assert.equal(imp.status, 200, imp.raw);
  assert.equal(imp.body.rejected.length, 0, imp.raw);
  assert.equal(
    (await call("biologist", "POST", "/api/lab/tests/import", LAB_TESTS_CSV, BIO)).status,
    200,
  );
});
after(async () => {
  await t.close();
  await db.drop();
});

const receive = (
  itemCode: string,
  lot: string,
  qty: number,
  depot = "MG",
  days = 300,
  as: "storekeeper" | "pharmacy" = "storekeeper",
) =>
  call(
    as,
    "POST",
    "/api/stock/receipts",
    { depot, lines: [{ itemCode, lotNumber: lot, expiresOn: exp(days), quantity: qty }] },
    KEEPER,
  );
const balance = async (itemCode: string, depot: string): Promise<number> =>
  Number(
    (
      await db.owner.query(
        `select coalesce(sum(s.quantity), 0) n from stock.stock_levels s join stock.lots l on l.id = s.lot_id where l.item_code = $1 and s.depot_code = $2`,
        [itemCode, depot],
      )
    ).rows[0].n,
  );
const lotId = async (itemCode: string, lot: string): Promise<string> =>
  (
    await db.owner.query("select id from stock.lots where item_code = $1 and lot_number = $2", [
      itemCode,
      lot,
    ])
  ).rows[0].id;

test("articles : un seul catalogue pour médicaments et consommables, chaque famille a son gestionnaire", async () => {
  // Les médicaments du catalogue sont déjà des articles.
  const drugs = await call("pharmacy", "GET", "/api/stock/items?kind=drug");
  assert.ok(drugs.body.items.some((i: { code: string }) => i.code === "PAR-500"));
  const supplies = await call(
    "storekeeper",
    "GET",
    "/api/stock/items?q=seringue",
    undefined,
    KEEPER,
  );
  assert.equal(supplies.body.items[0].code, "SYR-5");

  // Import : famille inconnue, médicament, doublon.
  const bad = await call(
    "storekeeper",
    "POST",
    "/api/stock/items/import",
    `${ITEMS_CSV.split("\n")[0]}\nX1,Gants,قفازات,jouet,paire,Moi,2026-11-01\nPAR-500,Paracétamol,x,consommable,boîte,Moi,2026-11-01\nSYR-5,Seringue,x,consommable,seringue,Moi,2026-11-01\nSYR-5,Doublon,x,consommable,seringue,Moi,2026-11-01\n`,
    KEEPER,
  );
  assert.equal(bad.body.imported, 1);
  assert.equal(bad.body.rejected.length, 3);
  assert.equal(
    (await call("storekeeper", "POST", "/api/stock/items/import", "code,libelle_fr\nX,Y\n", KEEPER))
      .status,
    400,
  );
  assert.equal(
    (await call("pharmacy", "POST", "/api/stock/items/import", ITEMS_CSV)).body.error.code,
    "wrong_item_family",
  );
  assert.equal((await call("doctor", "POST", "/api/stock/items/import", ITEMS_CSV)).status, 403);

  // Chacun ne réceptionne que sa famille.
  assert.equal((await receive("SYR-5", "S-1", 200)).status, 201);
  assert.equal(
    (await receive("SYR-5", "S-2", 10, "PC", 300, "pharmacy")).body.error.code,
    "wrong_item_family",
  );
  assert.equal(
    (await receive("PAR-500", "P-9", 10, "MG", 300, "storekeeper")).body.error.code,
    "wrong_item_family",
  );
  assert.equal((await receive("PAR-500", "P-9", 10, "PC", 300, "pharmacy")).status, 201);
  assert.equal(
    (await call("storekeeper", "GET", "/api/patients?q=abc", undefined, KEEPER)).status,
    403,
    "le magasinier n'a aucun accès aux dossiers de patients",
  );
  assert.equal((await call("cashier", "GET", "/api/stock/items")).status, 403);
});

test("transferts : du magasin central vers la réserve d'un service, en deux mouvements liés, sans stock négatif", async () => {
  await receive("SYR-5", "T-1", 50, "MG", 200);
  const lot = await lotId("SYR-5", "T-1");
  const tr = await call(
    "storekeeper",
    "POST",
    "/api/stock/transfers",
    {
      from: "MG",
      to: "HOSP",
      lines: [{ lotId: lot, quantity: 20 }],
      note: "Dotation hebdomadaire",
    },
    KEEPER,
  );
  assert.equal(tr.status, 201, tr.raw);
  assert.match(tr.body.number, /^T-\d{6}$/);
  assert.equal(await balance("SYR-5", "HOSP"), 20);
  const mv = await db.owner.query(
    "select kind, quantity, depot_code from stock.movements where ref_id = $1 order by id",
    [tr.body.number],
  );
  assert.deepEqual(
    mv.rows.map((r) => [r.kind, r.quantity, r.depot_code]),
    [
      ["transfer_out", -20, "MG"],
      ["transfer_in", 20, "HOSP"],
    ],
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        "/api/stock/transfers",
        { from: "MG", to: "HOSP", lines: [{ lotId: lot, quantity: 999 }] },
        KEEPER,
      )
    ).body.error.code,
    "insufficient_stock",
  );
  assert.equal(await balance("SYR-5", "HOSP"), 20, "un transfert refusé ne change rien");
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        "/api/stock/transfers",
        { from: "MG", to: "MG", lines: [{ lotId: lot, quantity: 1 }] },
        KEEPER,
      )
    ).body.error.code,
    "same_depot",
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        "/api/stock/transfers",
        { from: "MG", to: "NOPE", lines: [{ lotId: lot, quantity: 1 }] },
        KEEPER,
      )
    ).body.error.code,
    "unknown_depot",
  );
  const dead = await db.owner.query(
    "insert into stock.lots (item_code, lot_number, expires_on) values ('SYR-5', 'T-DEAD', $1) returning id",
    [exp(-3)],
  );
  await db.owner.query(
    "insert into stock.stock_levels (depot_code, lot_id, quantity) values ('MG', $1, 5)",
    [dead.rows[0].id],
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        "/api/stock/transfers",
        { from: "MG", to: "HOSP", lines: [{ lotId: dead.rows[0].id, quantity: 1 }] },
        KEEPER,
      )
    ).body.error.code,
    "lot_expired",
  );
  assert.equal((await call("nurse", "POST", "/api/stock/transfers", {})).status, 403);
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'stock.transfer'")).rowCount,
    1,
  );
});

test("utilisation de matériel hors acte : tracée par patient et par lot, refusée si le stock manque", async () => {
  await receive("SYR-5", "U-1", 10, "HOSP", 100);
  const p = await newPatient(call, "Materiel");
  const use = await call(
    "nurse",
    "POST",
    "/api/stock/consumptions",
    {
      depot: "HOSP",
      itemCode: "SYR-5",
      quantity: 3,
      patientId: p.id,
      reason: "Seringues supplémentaires pendant le pansement",
    },
    "inf-stock",
  );
  assert.equal(use.status, 201, use.raw);
  assert.equal(use.body.consumed, 3);
  const mv = await db.owner.query(
    "select kind, quantity, patient_id, ref_type, reason from stock.movements where patient_id = $1",
    [p.id],
  );
  assert.deepEqual(
    [mv.rows[0].kind, mv.rows[0].quantity, mv.rows[0].ref_type],
    ["consume", -3, "manual"],
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        "/api/stock/consumptions",
        { depot: "HOSP", itemCode: "SYR-5", quantity: 5000, reason: "trop" },
        "inf-stock",
      )
    ).body.error.code,
    "insufficient_stock",
  );
  assert.equal(
    (
      await call(
        "nurse",
        "POST",
        "/api/stock/consumptions",
        { depot: "HOSP", itemCode: "SYR-5", quantity: 1, reason: "x" },
        "inf-stock",
      )
    ).status,
    400,
    "motif obligatoire",
  );
  assert.equal(
    (
      await call("cashier", "POST", "/api/stock/consumptions", {
        depot: "HOSP",
        itemCode: "SYR-5",
        quantity: 1,
        reason: "caissier",
      })
    ).status,
    403,
  );
  // Retrouvé dans la traçabilité du lot.
  const lot = await lotId("SYR-5", "U-1");
  const trace = await call(
    "storekeeper",
    "GET",
    `/api/stock/lots/${lot}/patients`,
    undefined,
    KEEPER,
  );
  assert.equal(trace.body.uses.length, 1);
  assert.equal(trace.body.uses[0].patient.identifier, p.identifier);
  assert.equal(trace.body.uses[0].quantity, 3);
});

async function labRequest() {
  const patient = await newPatient(call, "Reactif");
  const adm = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    {
      patientId: patient.id,
      encounterId: adm.encounter.id,
      items: [{ actCode: "LAB-GLY", quantity: 1 }],
    },
    DR,
  );
  await t.dispatcher.drain();
  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${order.body.number}`,
    undefined,
    CASHIER,
  );
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  await t.dispatcher.drain();
  const reqs = await call(
    "lab",
    "GET",
    `/api/lab/requests?patientId=${patient.id}`,
    undefined,
    TECH,
  );
  return { patient, request: reqs.body.requests[0] as { id: string; ticketCode: string } };
}
async function labComplete() {
  const r = await labRequest();
  const sp = await call(
    "lab",
    "POST",
    `/api/lab/requests/${r.request.id}/collect`,
    { patientScan: cardPayload(r.patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  await call("lab", "POST", "/api/lab/specimens/receive", { scan: sp.body.payload }, TECH);
  await call(
    "lab",
    "POST",
    `/api/lab/specimens/${sp.body.id}/results`,
    { testCode: "GLY", value: 5 },
    TECH,
  );
  await call("lab", "POST", `/api/lab/specimens/${sp.body.id}/validate-technical`, {}, TECH);
  const done = await call(
    "biologist",
    "POST",
    `/api/lab/specimens/${sp.body.id}/validate-biological`,
    {},
    BIO,
  );
  assert.equal(done.body.requestComplete, true);
  return r;
}

test("recette d'un acte : les réactifs sont prélevés à la fin de l'analyse, par lot, pour le patient ; une seule fois", async () => {
  const recipe = {
    items: [
      { itemCode: "REA-GLY", quantity: 2 },
      { itemCode: "SYR-5", quantity: 1 },
    ],
    responsible: "Biologiste test",
    updatedOn: "2026-11-01",
  };
  assert.equal((await call("doctor", "PUT", "/api/stock/recipes/LAB-GLY", recipe)).status, 403);
  assert.equal(
    (await call("storekeeper", "PUT", "/api/stock/recipes/NOPE", recipe, KEEPER)).status,
    404,
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "PUT",
        "/api/stock/recipes/LAB-GLY",
        {
          ...recipe,
          items: [
            { itemCode: "REA-GLY", quantity: 1 },
            { itemCode: "REA-GLY", quantity: 1 },
          ],
        },
        KEEPER,
      )
    ).body.error.code,
    "duplicate_item",
  );
  assert.equal(
    (await call("storekeeper", "PUT", "/api/stock/recipes/LAB-GLY", recipe, KEEPER)).status,
    200,
  );
  const listed = await call(
    "storekeeper",
    "GET",
    "/api/stock/recipes?act=LAB-GLY",
    undefined,
    KEEPER,
  );
  assert.deepEqual(
    listed.body.recipes
      .map((r: { itemCode: string; quantity: number }) => [r.itemCode, r.quantity])
      .sort(),
    [
      ["REA-GLY", 2],
      ["SYR-5", 1],
    ],
  );

  // Réserve du laboratoire : deux lots, le plus proche de la péremption part d'abord.
  await receive("REA-GLY", "R-LATE", 10, "LAB", 400);
  await receive("REA-GLY", "R-SOON", 1, "LAB", 60);
  await receive("SYR-5", "L-1", 5, "LAB", 100);
  const synBefore = await balance("SYR-5", "LAB");
  const r = await labComplete();
  await t.dispatcher.drain();
  assert.equal(await balance("REA-GLY", "LAB"), 9, "2 réactifs prélevés sur 11");
  assert.equal(await balance("SYR-5", "LAB"), synBefore - 1);
  const mv = await db.owner.query(
    `select l.lot_number, m.quantity, m.patient_id, m.ref_id from stock.movements m join stock.lots l on l.id = m.lot_id where m.kind = 'consume' and m.ref_id = $1 and l.item_code = 'REA-GLY' order by l.lot_number`,
    [r.request.ticketCode],
  );
  assert.deepEqual(
    mv.rows.map((x) => [x.lot_number, x.quantity]),
    [
      ["R-LATE", -1],
      ["R-SOON", -1],
    ],
    "premier périmé, premier sorti",
  );
  assert.ok(mv.rows.every((x) => x.patient_id === r.patient.id));
  await t.dispatcher.drain();
  assert.equal(await balance("REA-GLY", "LAB"), 9, "pas de double prélèvement");
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'stock.consume-act'")).rowCount,
    1,
  );
  assert.equal((await db.owner.query("select count(*)::int n from stock.shortfalls")).rows[0].n, 0);
});

test("stock insuffisant à la fin d'un acte : ce qui existe est prélevé, le manque est signalé puis régularisé", async () => {
  // Il reste 9 réactifs en réserve : on en retire pour qu'il n'en reste qu'un.
  const lots = await db.owner.query(
    "select l.id, s.quantity from stock.stock_levels s join stock.lots l on l.id = s.lot_id where l.item_code = 'REA-GLY' and s.depot_code = 'LAB' and s.quantity > 0",
  );
  const keep = lots.rows[0];
  const inv = await call(
    "storekeeper",
    "POST",
    "/api/stock/inventory",
    {
      depot: "LAB",
      counts: [{ lotId: keep.id, counted: 1 }],
      reason: "Casse de flacons constatée",
      apply: true,
    },
    KEEPER,
  );
  assert.equal(inv.status, 200, inv.raw);
  assert.equal(await balance("REA-GLY", "LAB"), 1);
  const r = await labComplete();
  await t.dispatcher.drain();
  assert.equal(await balance("REA-GLY", "LAB"), 0, "le dernier réactif est prélevé");
  const open = await call("storekeeper", "GET", "/api/stock/shortfalls", undefined, KEEPER);
  assert.equal(open.body.shortfalls.length, 1);
  const sf = open.body.shortfalls[0];
  assert.deepEqual(
    [sf.itemCode, sf.missing, sf.actCode, sf.depot, sf.refId],
    ["REA-GLY", 1, "LAB-GLY", "LAB", r.request.ticketCode],
  );
  assert.equal((await call("direction", "GET", "/api/dashboard")).body.stock.openShortfalls, 1);
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        `/api/stock/shortfalls/${sf.id}/resolve`,
        { resolution: "x" },
        KEEPER,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("nurse", "POST", `/api/stock/shortfalls/${sf.id}/resolve`, {
        resolution: "Régularisé après réception",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        `/api/stock/shortfalls/${sf.id}/resolve`,
        { resolution: "Régularisé après réception du lot R-NEW" },
        KEEPER,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        `/api/stock/shortfalls/${sf.id}/resolve`,
        { resolution: "Une seconde fois" },
        KEEPER,
      )
    ).body.error.code,
    "already_resolved",
  );
  assert.equal(
    (await call("storekeeper", "GET", "/api/stock/shortfalls", undefined, KEEPER)).body.shortfalls
      .length,
    0,
  );
});

test("imagerie : film et produit de contraste prélevés dans la réserve de l'imagerie à la fin de l'examen", async () => {
  assert.equal(
    (
      await call(
        "storekeeper",
        "PUT",
        "/api/stock/recipes/IMG-RX",
        {
          items: [
            { itemCode: "FILM-35", quantity: 1 },
            { itemCode: "CONTR", quantity: 2 },
          ],
          responsible: "Radiologue test",
          updatedOn: "2026-11-01",
        },
        KEEPER,
      )
    ).status,
    200,
  );
  await receive("FILM-35", "F-1", 100, "IMG", 500);
  await receive("CONTR", "C-1", 20, "IMG", 200);
  const patient = await newPatient(call, "Radio");
  const adm = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    {
      patientId: patient.id,
      encounterId: adm.encounter.id,
      items: [{ actCode: "IMG-RX", quantity: 1 }],
    },
    DR,
  );
  await t.dispatcher.drain();
  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${order.body.number}`,
    undefined,
    CASHIER,
  );
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  await t.dispatcher.drain();
  const exam = (
    await call("imaging", "GET", `/api/imaging/requests?patientId=${patient.id}`, undefined, IMG)
  ).body.requests[0];
  await call("imaging", "POST", `/api/imaging/requests/${exam.id}/perform`, {}, IMG);
  assert.equal(await balance("FILM-35", "IMG"), 100, "rien n'est prélevé avant la fin de l'examen");
  await call(
    "imaging",
    "POST",
    `/api/imaging/requests/${exam.id}/report`,
    { findings: "Sans particularité.", conclusion: "Normal (exemple de test)." },
    IMG,
  );
  await t.dispatcher.drain();
  assert.equal(await balance("FILM-35", "IMG"), 99);
  assert.equal(await balance("CONTR", "IMG"), 18);
});

test("alertes et seuils s'appliquent à tous les articles ; la direction ne voit que des chiffres", async () => {
  assert.equal(
    (await call("storekeeper", "PUT", "/api/stock/thresholds/CONTR", { minimum: 50 }, KEEPER))
      .status,
    200,
  );
  assert.equal(
    (await call("pharmacy", "PUT", "/api/stock/thresholds/CONTR", { minimum: 5 })).body.error.code,
    "wrong_item_family",
  );
  const a = await call("storekeeper", "GET", "/api/stock/alerts", undefined, KEEPER);
  assert.ok(
    a.body.belowThreshold.some(
      (x: { itemCode: string; total: number }) => x.itemCode === "CONTR" && x.total === 18,
    ),
  );
  const levels = await call("storekeeper", "GET", "/api/stock/levels?depot=IMG", undefined, KEEPER);
  assert.ok(levels.body.lots.every((l: { depot: string }) => l.depot === "IMG"));
  assert.ok(
    levels.body.lots.some(
      (l: { kind: string; unit: string }) => l.kind === "consumable" && l.unit === "flacon",
    ),
  );
  assert.equal((await call("direction", "GET", "/api/stock/levels")).status, 403);
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        "/api/stock/depots",
        { code: "BLOC2", name: "Réserve du bloc 2", kind: "bloc", servesDepartment: "HOSP" },
        KEEPER,
      )
    ).body.error.code,
    "department_has_depot",
  );
  assert.equal(
    (
      await call(
        "storekeeper",
        "POST",
        "/api/stock/depots",
        { code: "MAT", name: "Réserve maternité", kind: "ward" },
        KEEPER,
      )
    ).status,
    201,
  );
  await assert.rejects(
    db.owner.query("update stock.movements set quantity = 1"),
    /ne se modifie ni ne se supprime/,
  );
});
