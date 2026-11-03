import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseCsv, toCsv } from "../src/common/csv.ts";
import { allocate, splitAmount } from "../src/common/money.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import { ACTS_CSV, makeCaller, PAYERS_CSV, type Caller } from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
});
after(async () => {
  await t.close();
  await db.drop();
});

test("CSV : guillemets, virgules, fins de ligne Windows et BOM", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","dit ""oui"""\r\n\r\n2,,3\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "x, y", 'dit "oui"'],
    ["2", "", "3"],
  ]);
  assert.deepEqual(parseCsv(toCsv([["a", 'b,"c"']])), [["a", 'b,"c"']]);
});

test("montants : le partage patient / payeur est exact", () => {
  assert.deepEqual(splitAmount(2000, 0.2), { patientAmount: 400, payerAmount: 1600 });
  assert.deepEqual(splitAmount(1001, 0.5), { patientAmount: 501, payerAmount: 500 });
  assert.deepEqual(splitAmount(5000, 0), { patientAmount: 0, payerAmount: 5000 });
});

test("répartition d'un montant : la somme est toujours exacte", () => {
  for (let amount = 0; amount < 200; amount += 7) {
    for (const weights of [[1, 1, 1], [3000, 2500, 6000], [1, 2], [5], [0, 0, 7]]) {
      const shares = allocate(amount, weights);
      assert.equal(
        shares.reduce((a, b) => a + b, 0),
        amount,
        `${amount} / ${weights}`,
      );
      assert.ok(shares.every((s) => s >= 0));
    }
  }
});

test("F2-2 : import des actes, rapport ligne par ligne, aucune ligne invalide importée", async () => {
  await call("admin", "POST", "/api/catalog/payers/import", PAYERS_CSV);
  const csv = `code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj
OK-1,Acte valide,فحص صالح,1000,LAB,laboratoire,Resp,2026-11-01
BAD-PRICE,Prix faux,x,12abc,LAB,laboratoire,Resp,2026-11-01
BAD-DEPT,Service inconnu,x,1000,XXX,laboratoire,Resp,2026-11-01
BAD-CAT,Catégorie inconnue,x,1000,LAB,magie,Resp,2026-11-01
BAD-DATE,Date fausse,x,1000,LAB,laboratoire,Resp,2026-13-45
,Sans code,x,1000,LAB,laboratoire,Resp,2026-11-01
OK-2,Acte valide 2,فحص ثان,2000,IMG,imagerie,Resp,2026-11-01
OK-1,Doublon,x,1000,LAB,laboratoire,Resp,2026-11-01
`;
  const res = await call("admin", "POST", "/api/catalog/acts/import", csv);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.total, 8);
  assert.equal(res.body.created, 2);
  assert.equal(res.body.rejected.length, 6);
  const lines = res.body.rejected.map((r: { line: number }) => r.line);
  assert.deepEqual(lines, [3, 4, 5, 6, 7, 9]);
  const bad = Object.fromEntries(
    res.body.rejected.map((r: { code: string; errors: string[] }) => [r.code, r.errors.join(" ")]),
  );
  assert.match(bad["BAD-PRICE"], /tarif/);
  assert.match(bad["BAD-DEPT"], /service inconnu/);
  assert.match(bad["BAD-CAT"], /catégorie/);
  assert.match(bad["BAD-DATE"], /date/);
  const stored = await db.owner.query("select code from catalog.acts where code like 'BAD%'");
  assert.equal(stored.rowCount, 0, "aucune ligne invalide n'est enregistrée");
  const dup = res.body.rejected.find((r: { line: number }) => r.line === 9);
  assert.match(dup.errors.join(" "), /double/);
});

test("F2-2 : réimport identique = rien ne change ; un changement de tarif est historisé", async () => {
  const first = await call("admin", "POST", "/api/catalog/acts/import", ACTS_CSV);
  assert.equal(first.body.created, 6);
  const same = await call("admin", "POST", "/api/catalog/acts/import", ACTS_CSV);
  assert.equal(same.body.unchanged, 6);
  assert.equal(same.body.created + same.body.updated, 0);
  const changed = await call(
    "admin",
    "POST",
    "/api/catalog/acts/import",
    ACTS_CSV.replace("LAB-GLY,Glycémie,سكر الدم,1500", "LAB-GLY,Glycémie,سكر الدم,1800"),
  );
  assert.equal(changed.body.updated, 1);
  const history = await db.owner.query(
    "select before, after, changed_by from catalog.history where code = 'LAB-GLY' order by id desc limit 1",
  );
  assert.equal(history.rows[0].before.tariff, 1500);
  assert.equal(history.rows[0].after.tariff, 1800);
  assert.equal(history.rows[0].changed_by, "sub-admin");
  await call("admin", "POST", "/api/catalog/acts/import", ACTS_CSV); // remet 1500 pour la suite
});

test("F2-2 : mode strict, une erreur annule tout ; en-tête faux refusé ; droits", async () => {
  const csv =
    ACTS_CSV +
    "NEW-1,Nouveau,جديد,100,LAB,laboratoire,Resp,2026-11-01\nBAD,Mauvais,x,abc,LAB,laboratoire,Resp,2026-11-01\n";
  const strict = await call("admin", "POST", "/api/catalog/acts/import?strict=true", csv);
  assert.equal(strict.body.applied, false);
  assert.equal(
    (await db.owner.query("select 1 from catalog.acts where code = 'NEW-1'")).rowCount,
    0,
  );
  const header = await call("admin", "POST", "/api/catalog/acts/import", "code,libelle\nA,B\n");
  assert.equal(header.status, 400);
  assert.equal(header.body.error.code, "invalid_header");
  assert.equal((await call("reception", "POST", "/api/catalog/acts/import", ACTS_CSV)).status, 403);
  assert.equal(
    (await call("cashier", "POST", "/api/catalog/payers/import", PAYERS_CSV)).status,
    403,
  );
  assert.equal((await call("reception", "GET", "/api/catalog/acts")).status, 200);
  assert.equal((await call("lab", "GET", "/api/catalog/acts")).status, 403);
});

test("F2-3 : import des payeurs, parts de 0 à 1 ou en pourcentage", async () => {
  const bad = `code,libelle_fr,libelle_ar,part_patient,responsable,date_maj
X1,Trop,x,1.5,Resp,2026-11-01
X2,Negatif,x,-0.1,Resp,2026-11-01
X3,Texte,x,beaucoup,Resp,2026-11-01
X4,Pourcent,x,30%,Resp,2026-11-01
`;
  const res = await call("admin", "POST", "/api/catalog/payers/import", bad);
  assert.equal(res.body.created, 1);
  assert.equal(res.body.rejected.length, 3);
  const payers = (await call("reception", "GET", "/api/catalog/payers")).body;
  assert.equal(payers.find((p: { code: string }) => p.code === "X4").patientShare, 0.3);
});
