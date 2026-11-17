import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  makeCaller,
  newPatient,
  openCash,
  type Caller,
} from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const DR = "dr-paie";
const CASHIER = "caissier-paie";

before(async () => {
  process.env.CONSULTATION_PAYMENT_REQUIRED = "true";
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  await openCash(call, CASHIER);
});
after(async () => {
  await t.close();
  await db.drop();
});

test("règle « on paie d'abord » appliquée à la consultation : refusée avant la caisse, acceptée après ; la file l'indique", async () => {
  const p = await newPatient(call, "Paie");
  const adm = await admitPatient(call, p.id);
  await t.dispatcher.drain();

  const queue = async () =>
    (await call("doctor", "GET", "/api/queue?department=CONS", undefined, DR)).body.queue.find(
      (e: { patientId: string }) => e.patientId === p.id,
    );
  assert.equal((await queue()).settled, false, "la file signale « non payé »");

  const early = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: p.id, encounterId: adm.encounter.id },
    DR,
  );
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, "consultation_unpaid");

  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&patientId=${p.id}`,
    undefined,
    CASHIER,
  );
  assert.equal(inv.body.invoices.length, 1);
  const paid = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  assert.equal(paid.status, 200, paid.raw);
  assert.equal((await queue()).settled, true, "la file signale « payé »");

  const ok = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: p.id, encounterId: adm.encounter.id },
    DR,
  );
  assert.equal(ok.status, 201, ok.raw);
});

test("un avoir sur l'admission annule le droit de consulter", async () => {
  const p = await newPatient(call, "Avoir");
  const adm = await admitPatient(call, p.id);
  const inv = (
    await call(
      "cashier",
      "GET",
      `/api/billing/invoices?status=pending&patientId=${p.id}`,
      undefined,
      CASHIER,
    )
  ).body.invoices[0];
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  const credit = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.id}/credit-note`,
    { reason: "Erreur de patient à l'accueil" },
    CASHIER,
  );
  assert.equal(credit.status, 201, credit.raw);
  const r = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: p.id, encounterId: adm.encounter.id },
    DR,
  );
  assert.equal(r.body.error.code, "consultation_unpaid", "facture annulée = plus payée");
});

test("les urgences ne sont jamais bloquées par le paiement", async () => {
  const csv =
    "code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj\nURG-ACC,Accueil des urgences,استقبال الطوارئ,3000,URG,consultation,Responsable test,2026-11-01\n";
  // l'import remplace le catalogue : on y remet les actes de base
  const base = (await call("admin", "GET", "/api/catalog/acts")).body as {
    code: string;
    labelFr: string;
    labelAr: string;
    tariff: number;
    departmentCode: string;
    category: string;
  }[];
  const rows = base.map(
    (a) =>
      `${a.code},${a.labelFr},${a.labelAr},${a.tariff},${a.departmentCode},${a.category === "consultation" ? "consultation" : a.category},Responsable test,2026-11-01`,
  );
  const imp = await call("admin", "POST", "/api/catalog/acts/import", csv + rows.join("\n") + "\n");
  assert.equal(imp.status, 200, imp.raw);
  const p = await newPatient(call, "Urg");
  const urgent = await admitPatient(call, p.id, { department: "URG", act: "URG-ACC" });
  const r = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: p.id, encounterId: urgent.encounter.id },
    DR,
  );
  assert.equal(r.status, 201, "aux urgences, pas de blocage par le paiement : " + r.raw);
});
