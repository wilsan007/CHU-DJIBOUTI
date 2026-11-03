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
const DR2 = "dr-2";

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

const line = (drugCode: string, dose = 1, perDay = 3, days = 5) => ({
  drugCode,
  dose,
  perDay,
  days,
  route: "oral" as const,
});

async function prescribe(
  consultation: { id: string },
  patientId: string,
  lines: ReturnType<typeof line>[],
  overrides: { key: string; justification: string }[] = [],
  sub = DR1,
) {
  return call(
    "doctor",
    "POST",
    "/api/prescriptions",
    { patientId, consultationId: consultation.id, lines, overrides },
    sub,
  );
}

test("F5-1 : catalogue des médicaments, une fiche par produit, recherche sans accents", async () => {
  const found = await call("doctor", "GET", "/api/catalog/drugs?q=paracetamol");
  assert.equal(found.status, 200, found.raw);
  assert.ok(found.body.drugs.some((d: { code: string }) => d.code === "PAR-500"));
  const again = await call(
    "admin",
    "POST",
    "/api/catalog/drugs/import",
    `code,dci,forme,dosage,libelle_ar,classe_allergie,classe_interaction,responsable,date_maj
PAR-500,Paracétamol,Comprimé,500 mg,باراسيتامول,,,Pharmacien test,2026-11-02
`,
  );
  assert.equal(again.status, 200, again.raw);
  const all = await call("doctor", "GET", "/api/catalog/drugs?q=paracetamol");
  assert.equal(
    all.body.drugs.filter((d: { code: string }) => d.code === "PAR-500").length,
    1,
    "pas de doublon",
  );
  const denied = await call("cashier", "POST", "/api/catalog/drugs/import", "x");
  assert.equal(denied.status, 403);
});

test("F5-2 : posologie standard ou libre, quantité calculée, numéros continus, propriétaire de la consultation", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Ordo");
  const res = await prescribe(consultation, patient.id, [
    line("PAR-500", 1, 3, 3),
    line("AZI-250", 2, 1, 5),
  ]);
  assert.equal(res.status, 201, res.raw);
  assert.match(res.body.number, /^P-\d{6}$/);
  assert.equal(res.body.status, "pending");
  const [par, azi] = res.body.lines;
  assert.equal(par.quantity, 9);
  assert.equal(par.fromStandard, true, "posologie standard validée");
  assert.equal(azi.quantity, 10);
  assert.equal(azi.fromStandard, false, "posologie libre");

  const dup = await prescribe(consultation, patient.id, [line("PAR-500"), line("PAR-500")]);
  assert.equal(dup.body.error.code, "duplicate_drug");

  const other = await prescribe(consultation, patient.id, [line("MET-500")], [], DR2);
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, "not_your_consultation");

  const second = await startConsultation(call, DR1, "Ordo2");
  const next = await prescribe(second.consultation, second.patient.id, [line("MET-500")]);
  const n = (x: string) => Number(x.slice(2));
  assert.equal(n(next.body.number), n(res.body.number) + 1, "numérotation sans trou");

  assert.equal((await call("cashier", "POST", "/api/prescriptions", {})).status, 403);
  const read = await call("pharmacy", "GET", `/api/prescriptions/${res.body.id}`);
  assert.equal(read.status, 200, read.raw);
  assert.equal(read.body.lines.length, 2);
});

test("F5-3 : allergie et interaction grave bloquent sans justification écrite, tracée", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Alerte");
  await call("doctor", "POST", `/api/patients/${patient.id}/allergies`, {
    substanceClass: "penicillin",
    label: "pénicilline",
    severity: "severe",
  });
  const check = await call("doctor", "POST", "/api/prescriptions/check", {
    patientId: patient.id,
    lines: [line("AMO-500"), line("WAR-5", 1, 1, 30), line("IBU-400")],
  });
  assert.equal(check.status, 200, check.raw);
  const kinds = check.body.alerts.map((a: { kind: string }) => a.kind).sort();
  assert.deepEqual(kinds, ["allergy", "interaction"]);
  const blocked = await prescribe(consultation, patient.id, [line("AMO-500")]);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "alerts_require_justification");
  const key = blocked.body.error.details.alerts[0].key as string;

  const short = await prescribe(
    consultation,
    patient.id,
    [line("AMO-500")],
    [{ key, justification: "ok" }],
  );
  assert.equal(short.status, 400);
  const unknown = await prescribe(
    consultation,
    patient.id,
    [line("PAR-500")],
    [{ key: "inexistante", justification: "sans objet réel" }],
  );
  assert.equal(unknown.body.error.code, "unknown_override");

  const ok = await prescribe(
    consultation,
    patient.id,
    [line("AMO-500")],
    [{ key, justification: "Allergie ancienne, test de tolérance fait en service." }],
  );
  assert.equal(ok.status, 201, ok.raw);
  const full = await call("doctor", "GET", `/api/prescriptions/${ok.body.id}`);
  assert.equal(full.body.overrides.length, 1);
  assert.equal(full.body.overrides[0].justifiedBy, ok.body.prescriber.id);
  const audit = await db.owner.query(
    "select 1 from audit.log where action = 'prescription.override' and entity_id = $1",
    [ok.body.id],
  );
  assert.equal(audit.rowCount, 1);
});

test("F5-3 : les interactions ne se règlent que par l'administration", async () => {
  const denied = await call("doctor", "PUT", "/api/catalog/interactions", {
    classA: "a",
    classB: "b",
    messageFr: "x",
    messageAr: "x",
    validatedBy: "x",
    validatedOn: "2026-11-01",
  });
  assert.equal(denied.status, 403);
});

test("F5-5 : la pharmacie voit les ordonnances à servir et l'événement est publié", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Pharma");
  const rx = await prescribe(consultation, patient.id, [line("MET-500", 1, 2, 30)]);
  assert.equal(rx.status, 201, rx.raw);
  const list = await call(
    "pharmacy",
    "GET",
    `/api/prescriptions?status=pending&patientId=${patient.id}`,
  );
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.body.prescriptions.length, 1);
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'PrescriptionCreated' and payload->>'prescriptionId' = $1",
    [rx.body.id],
  );
  assert.equal(ev.rowCount, 1);
  assert.equal(ev.rows[0].payload.lineCount, 1);
  assert.equal(ev.rows[0].payload.hadOverrides, false);
});

test("F5-4 : impression bilingue, code vérifiable, falsification et ancienne version détectées", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Impression");
  const rx = await prescribe(consultation, patient.id, [line("PAR-500", 1, 3, 3)]);
  const print = await call("doctor", "GET", `/api/prescriptions/${rx.body.id}/print`);
  assert.equal(print.status, 200, print.raw);
  assert.ok(print.body.html.includes("Ordonnance") && print.body.html.includes("وصفة طبية"));
  assert.match(print.body.payload, /^RX1\.P-\d{6}\.\d{2}$/);

  const ok = await call("pharmacy", "GET", `/api/prescriptions/verify/${print.body.payload}`);
  assert.equal(ok.body.valid, true, ok.raw);
  const parts = (print.body.payload as string).split(".");
  const wrong = String((Number(parts[2]) + 1) % 100).padStart(2, "0");
  const tamper = await call(
    "pharmacy",
    "GET",
    `/api/prescriptions/verify/${parts[0]}.${parts[1]}.${wrong}`,
  );
  assert.equal(tamper.status, 400);
  assert.equal(
    (await call("pharmacy", "GET", "/api/prescriptions/verify/n-importe-quoi")).status,
    400,
  );

  const rev = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.body.id}/revise`,
    { lines: [line("PAR-500", 1, 2, 3)], overrides: [], reason: "dose réduite" },
    DR1,
  );
  assert.equal(rev.status, 201, rev.raw);
  const old = await call("pharmacy", "GET", `/api/prescriptions/verify/${print.body.payload}`);
  assert.equal(old.body.superseded, true);
  assert.equal(old.body.valid, false);
  assert.equal(old.body.currentId, rev.body.prescription.id);
});

test("F5-6 : révision réservée au prescripteur et impossible après service ; renouvellement recontrôlé", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Revision");
  const rx = await prescribe(consultation, patient.id, [line("WAR-5", 1, 1, 30)]);
  assert.equal(rx.status, 201, rx.raw);

  const foreign = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.body.id}/revise`,
    { lines: [line("WAR-5", 1, 1, 10)], overrides: [], reason: "autre médecin" },
    DR2,
  );
  assert.equal(foreign.body.error.code, "not_your_prescription");

  // Renouvellement après apparition d'une allergie : l'alerte du jour s'applique.
  const closed = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.body.id}/revise`,
    {
      lines: [line("WAR-5", 1, 1, 20)],
      overrides: [],
      reason: "ajustement",
    },
    DR1,
  );
  assert.equal(closed.status, 201, closed.raw);
  const prev = await call("doctor", "GET", `/api/prescriptions/${rx.body.id}`);
  assert.equal(prev.body.status, "superseded");
  assert.equal(prev.body.currentId, closed.body.prescription.id);

  const again = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.body.id}/revise`,
    {
      lines: [line("WAR-5")],
      overrides: [],
      reason: "déjà remplacée",
    },
    DR1,
  );
  assert.equal(again.status, 409);

  const cur = closed.body.prescription;
  await db.owner.query(
    "update prescriptions.prescriptions set status = 'dispensed' where id = $1",
    [cur.id],
  );
  const late = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${cur.id}/revise`,
    {
      lines: [line("WAR-5")],
      overrides: [],
      reason: "trop tard",
    },
    DR1,
  );
  assert.equal(late.body.error.code, "already_dispensed");
});

test("F5-6 : le renouvellement recopie l'ordonnance mais applique les alertes d'aujourd'hui", async () => {
  const first = await startConsultation(call, DR1, "Renouv");
  const rx = await prescribe(first.consultation, first.patient.id, [line("AMO-500")]);
  assert.equal(rx.status, 201, rx.raw);
  await call("doctor", "POST", `/api/patients/${first.patient.id}/allergies`, {
    substanceClass: "penicillin",
    label: "pénicilline",
    severity: "severe",
  });
  const dx = await call(
    "doctor",
    "POST",
    `/api/consultations/${first.consultation.id}/diagnoses`,
    { code: "E11", primary: true },
    DR1,
  );
  assert.equal(dx.status, 201, dx.raw);
  const done = await call(
    "doctor",
    "POST",
    `/api/consultations/${first.consultation.id}/close`,
    undefined,
    DR1,
  );
  assert.equal(done.status, 200, done.raw);
  const c2 = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: first.patient.id, encounterId: first.encounterId },
    DR1,
  );
  assert.equal(c2.status, 201, c2.raw);
  const blocked = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.body.id}/renew`,
    { consultationId: c2.body.id, overrides: [] },
    DR1,
  );
  assert.equal(blocked.body.error.code, "alerts_require_justification");
  const key = blocked.body.error.details.alerts[0].key as string;
  const renewed = await call(
    "doctor",
    "POST",
    `/api/prescriptions/${rx.body.id}/renew`,
    {
      consultationId: c2.body.id,
      overrides: [{ key, justification: "Tolérance vérifiée avec le patient." }],
    },
    DR1,
  );
  assert.equal(renewed.status, 201, renewed.raw);
  assert.equal(renewed.body.renewalOf, rx.body.id);
  assert.notEqual(renewed.body.number, rx.body.number);
});

test("une ordonnance signée ne se modifie ni ne se supprime, même par SQL", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Immuable");
  const rx = await prescribe(consultation, patient.id, [line("PAR-500", 1, 3, 3)]);
  await assert.rejects(
    db.owner.query("update prescriptions.lines set quantity = 99 where prescription_id = $1", [
      rx.body.id,
    ]),
    /ne se modifie pas/,
  );
  await assert.rejects(
    db.owner.query("delete from prescriptions.prescriptions where id = $1", [rx.body.id]),
    /ne se supprime pas/,
  );
  await assert.rejects(
    db.owner.query("update prescriptions.prescriptions set prescriber_id = 'x' where id = $1", [
      rx.body.id,
    ]),
    /ne se modifie pas/,
  );
});
