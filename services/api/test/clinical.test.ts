import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  importClinicalCatalogs,
  makeCaller,
  newPatient,
  openCash,
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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

/* ------------------------------------------------------------------ F4-1 bandeau et allergies */

test("F4-1 : bandeau patient, allergies visibles seulement des rôles cliniques et de la pharmacie", async () => {
  const p = await newPatient(call, "Bandeau");
  const add = await call("doctor", "POST", `/api/patients/${p.id}/allergies`, {
    substanceClass: "penicillin",
    label: "pénicilline",
    severity: "severe",
  });
  assert.equal(add.status, 201, add.raw);
  const doctor = await call("doctor", "GET", `/api/patients/${p.id}/banner`);
  assert.equal(doctor.body.identifier, p.identifier);
  assert.equal(doctor.body.age, 41);
  assert.deepEqual(
    doctor.body.allergies.map((a: { substanceClass: string }) => a.substanceClass),
    ["penicillin"],
  );
  assert.ok(
    (await call("pharmacy", "GET", `/api/patients/${p.id}/banner`)).body.allergies.length === 1,
    "la pharmacie voit les allergies",
  );
  assert.equal(
    (await call("cashier", "GET", `/api/patients/${p.id}/banner`)).body.allergies,
    null,
    "la caisse ne voit pas les allergies",
  );
  assert.equal((await call("direction", "GET", `/api/patients/${p.id}/banner`)).status, 403);
  const old = await newPatient(call, "Ancien");
  await call("admin", "POST", "/api/patients/merge", {
    survivorId: p.id,
    mergedId: old.id,
    reason: "même personne",
  });
  const viaOld = await call("doctor", "GET", `/api/patients/${old.id}/banner`);
  assert.equal(viaOld.body.id, p.id);
  assert.equal(viaOld.body.redirectedFrom, old.identifier);
  assert.equal(viaOld.body.allergies.length, 1, "les allergies suivent la fusion");
});

test("allergies : pas de doublon, jamais supprimées, seulement marquées « saisies par erreur »", async () => {
  const p = await newPatient(call);
  const first = await call("doctor", "POST", `/api/patients/${p.id}/allergies`, {
    substanceClass: "sulfonamide",
    label: "sulfamides",
  });
  assert.equal(first.body.severity, "unknown");
  assert.equal(
    (
      await call("doctor", "POST", `/api/patients/${p.id}/allergies`, {
        substanceClass: "sulfonamide",
        label: "encore",
      })
    ).body.error.code,
    "allergy_exists",
  );
  assert.equal(
    (
      await call("reception", "POST", `/api/patients/${p.id}/allergies`, {
        substanceClass: "x",
        label: "x",
      })
    ).status,
    403,
  );
  assert.equal((await call("doctor", "POST", `/api/allergies/${first.body.id}/void`)).status, 200);
  assert.equal(
    (await call("doctor", "GET", `/api/patients/${p.id}/banner`)).body.allergies.length,
    0,
  );
  assert.equal(
    (await db.owner.query("select status from clinical.allergies where id = $1", [first.body.id]))
      .rows[0].status,
    "entered_in_error",
  );
  assert.equal(
    (await call("doctor", "POST", `/api/allergies/${first.body.id}/void`)).status,
    404,
    "déjà annulée",
  );
});

/* ------------------------------------------------------------------ ouverture, modèles, conflits */

test("F4 : une seule consultation ouverte par admission ; bon patient ; admission ouverte", async () => {
  const { patient, encounterId } = await startConsultation(call, DR1);
  const again = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: patient.id, encounterId },
    DR1,
  );
  assert.equal(again.body.error.code, "consultation_already_open");
  const other = await newPatient(call);
  assert.equal(
    (await call("doctor", "POST", "/api/consultations", { patientId: other.id, encounterId }, DR1))
      .body.error.code,
    "encounter_mismatch",
  );
  assert.equal(
    (await call("reception", "POST", "/api/consultations", { patientId: patient.id, encounterId }))
      .status,
    403,
  );
  assert.equal(
    (await call("lab", "GET", "/api/consultations/00000000-0000-4000-8000-000000000000")).status,
    403,
  );
});

test("F4-4 : modèles par spécialité, préremplissage, réservé à l'administration", async () => {
  const tpl = await call("admin", "PUT", "/api/clinical/templates", {
    specialty: "endocrinologie",
    name: "Contrôle diabète",
    reasonText: "Contrôle de routine d'un diabète connu.",
    examText: "Pieds, tension, poids.",
  });
  assert.equal(tpl.status, 200, tpl.raw);
  assert.equal(
    (await call("doctor", "PUT", "/api/clinical/templates", { specialty: "x", name: "y" })).status,
    403,
  );
  const list = await call("doctor", "GET", "/api/clinical/templates?specialty=endocrinologie");
  assert.equal(list.body.templates.length, 1);
  const patient = await newPatient(call);
  const adm = await admitPatient(call, patient.id);
  const c = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: patient.id, encounterId: adm.encounter.id, templateId: tpl.body.id },
    DR1,
  );
  assert.equal(c.body.reason, "Contrôle de routine d'un diabète connu.");
  assert.equal(c.body.exam, "Pieds, tension, poids.");
});

test("modification simultanée : rien n'est écrasé, les deux versions sont renvoyées", async () => {
  const { consultation } = await startConsultation(call, DR1);
  const first = await call(
    "doctor",
    "PUT",
    `/api/consultations/${consultation.id}`,
    { expectedVersion: 1, reason: "fièvre depuis 3 jours" },
    DR1,
  );
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.body.version, 2);
  const stale = await call(
    "doctor",
    "PUT",
    `/api/consultations/${consultation.id}`,
    { expectedVersion: 1, reason: "autre saisie" },
    DR1,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "edit_conflict");
  assert.equal(stale.body.error.details.current.reason, "fièvre depuis 3 jours");
  assert.equal(stale.body.error.details.submitted.reason, "autre saisie");
  assert.equal(
    (
      await call(
        "doctor",
        "PUT",
        `/api/consultations/${consultation.id}`,
        { expectedVersion: 2, exam: "gorge rouge" },
        DR1,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "doctor",
        "PUT",
        `/api/consultations/${consultation.id}`,
        { expectedVersion: 3, notes: "x" },
        DR2,
      )
    ).body.error.code,
    "not_your_consultation",
  );
});

/* ------------------------------------------------------------------ F4-2 constantes */

test("F4-2 : valeur normale ; inhabituelle = confirmation ; impossible = refus ; l'infirmier peut saisir", async () => {
  const { consultation } = await startConsultation(call, DR1);
  const vital = (body: unknown, role: "doctor" | "nurse" = "doctor", sub = DR1) =>
    call(role, "POST", `/api/consultations/${consultation.id}/vitals`, body, sub);
  assert.equal((await vital({ kind: "temperature", value: 37.2 })).status, 201);
  const unusual = await vital({ kind: "temperature", value: 41.5 });
  assert.equal(unusual.status, 409);
  assert.equal(unusual.body.error.code, "value_needs_confirmation");
  assert.equal(unusual.body.error.details.limits.unit, "celsius");
  const confirmed = await vital({ kind: "temperature", value: 41.5, confirm: true });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.confirmedUnusual, true);
  const impossible = await vital({ kind: "pulse", value: 900, confirm: true });
  assert.equal(
    impossible.body.error.code,
    "vital_impossible",
    "même confirmée, une valeur impossible est refusée",
  );
  assert.equal((await vital({ kind: "tempo", value: 1 })).status, 400);
  assert.equal(
    (await vital({ kind: "weight", value: 64 }, "nurse", "inf-1")).status,
    201,
    "l'infirmier saisit les constantes",
  );
  assert.equal(
    (
      await call("reception", "POST", `/api/consultations/${consultation.id}/vitals`, {
        kind: "weight",
        value: 64,
      })
    ).status,
    403,
  );
  const read = await call("doctor", "GET", `/api/consultations/${consultation.id}`, undefined, DR1);
  assert.equal(read.body.vitals.length, 3);
  const limits = await call("doctor", "GET", "/api/catalog/vital-limits");
  assert.ok(
    limits.body.limits.every((l: { validated: boolean }) => l.validated === false),
    "seuils d'exemple, à faire valider",
  );
});

/* ------------------------------------------------------------------ F4-3 diagnostics */

test("F4-3 : auto-complétion CIM-10 sans accents ; diagnostic principal ; seul le propriétaire modifie", async () => {
  const search = await call("doctor", "GET", "/api/catalog/diagnoses?q=diabete");
  assert.equal(search.body.diagnoses[0].code, "E11");
  assert.equal(
    (await call("doctor", "GET", "/api/catalog/diagnoses?q=J0")).body.diagnoses[0].code,
    "J06",
  );
  assert.equal(
    (await call("doctor", "GET", "/api/catalog/diagnoses?q=%D8%A7%D9%84%D8%B3%D9%83%D8%B1%D9%8A"))
      .body.diagnoses[0].code,
    "E11",
  );

  const { consultation } = await startConsultation(call, DR1);
  const url = `/api/consultations/${consultation.id}/diagnoses`;
  const first = await call("doctor", "POST", url, { code: "E11" }, DR1);
  assert.equal(first.body.diagnoses[0].primary, true, "le premier devient principal");
  const second = await call("doctor", "POST", url, { code: "I10" }, DR1);
  assert.equal(
    second.body.diagnoses.find((d: { code: string }) => d.code === "I10").primary,
    false,
  );
  const swapped = await call("doctor", "POST", url, { code: "I10", primary: true }, DR1);
  assert.deepEqual(
    swapped.body.diagnoses.map((d: { code: string; primary: boolean }) => [d.code, d.primary]),
    [
      ["I10", true],
      ["E11", false],
    ],
  );
  assert.equal((await call("doctor", "POST", url, { code: "ZZZ" }, DR1)).status, 404);
  assert.equal(
    (await call("doctor", "POST", url, { code: "J06" }, DR2)).body.error.code,
    "not_your_consultation",
  );
  const removed = await call("doctor", "DELETE", `${url}/E11`, undefined, DR1);
  assert.equal(removed.body.diagnoses.length, 1);
});

/* ------------------------------------------------------------------ F4-6 clôture, compte rendu */

test("F4-6 : clôture impossible sans diagnostic codé ; compte rendu bilingue archivé ; plus de modification", async () => {
  const { patient, consultation } = await startConsultation(call, DR1, "Cloture");
  await call(
    "doctor",
    "PUT",
    `/api/consultations/${consultation.id}`,
    { expectedVersion: 1, reason: "toux", exam: "auscultation normale" },
    DR1,
  );
  await call(
    "nurse",
    "POST",
    `/api/consultations/${consultation.id}/vitals`,
    { kind: "temperature", value: 38.1 },
    "inf-1",
  );
  const refused = await call(
    "doctor",
    "POST",
    `/api/consultations/${consultation.id}/close`,
    undefined,
    DR1,
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "diagnosis_required");
  assert.equal(
    (await call("doctor", "GET", `/api/consultations/${consultation.id}/report`, undefined, DR1))
      .body.error.code,
    "not_closed",
  );
  await call(
    "doctor",
    "POST",
    `/api/consultations/${consultation.id}/diagnoses`,
    { code: "J06" },
    DR1,
  );
  assert.equal(
    (await call("doctor", "POST", `/api/consultations/${consultation.id}/close`, undefined, DR2))
      .body.error.code,
    "not_your_consultation",
  );
  const closed = await call(
    "doctor",
    "POST",
    `/api/consultations/${consultation.id}/close`,
    undefined,
    DR1,
  );
  assert.equal(closed.status, 200, closed.raw);
  assert.equal(closed.body.status, "closed");

  const report = await call(
    "doctor",
    "GET",
    `/api/consultations/${consultation.id}/report`,
    undefined,
    DR1,
  );
  assert.equal(report.status, 200);
  assert.match(report.body.html, /Compte rendu de consultation/);
  assert.match(report.body.html, /تقرير الاستشارة/);
  assert.match(report.body.html, /J06/);
  assert.match(report.body.html, /Température : 38.1 celsius/);
  assert.match(report.body.html, new RegExp(patient.identifier));
  assert.equal(report.body.sha256.length, 64);

  assert.equal(
    (
      await call(
        "doctor",
        "PUT",
        `/api/consultations/${consultation.id}`,
        { expectedVersion: 99, notes: "x" },
        DR1,
      )
    ).body.error.code,
    "consultation_closed",
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/consultations/${consultation.id}/vitals`,
        { kind: "weight", value: 60 },
        DR1,
      )
    ).body.error.code,
    "consultation_closed",
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/consultations/${consultation.id}/diagnoses`,
        { code: "I10" },
        DR1,
      )
    ).body.error.code,
    "consultation_closed",
  );
  // Garde de dernier recours dans la base, même pour le propriétaire.
  await assert.rejects(
    () =>
      db.owner.query("update clinical.consultations set notes = 'altéré' where id = $1", [
        consultation.id,
      ]),
    /clôturée/,
  );
  await assert.rejects(
    () =>
      db.owner.query("delete from clinical.consultation_diagnoses where consultation_id = $1", [
        consultation.id,
      ]),
    /clôturée/,
  );
  await assert.rejects(
    () =>
      db.owner.query("update clinical.documents set html = 'x' where consultation_id = $1", [
        consultation.id,
      ]),
    /ajout seul/,
  );
  const audit = await db.owner.query(
    "select action from audit.log where entity_id = $1 and action like 'consultation.%' order by id",
    [consultation.id],
  );
  assert.ok(audit.rows.some((r) => r.action === "consultation.close"));
});

test("F4-6 : la clôture sort le patient de la file d'attente et honore son rendez-vous", async () => {
  const patient = await newPatient(call, "File");
  const adm = await admitPatient(call, patient.id);
  await t.dispatcher.drain();
  const queue = (await call("reception", "GET", "/api/queue?department=CONS")).body.queue;
  assert.ok(
    queue.some(
      (e: { patient: { identifier: string } }) => e.patient.identifier === patient.identifier,
    ),
  );
  const c = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: patient.id, encounterId: adm.encounter.id },
    DR1,
  );
  await call("doctor", "POST", `/api/consultations/${c.body.id}/diagnoses`, { code: "E11" }, DR1);
  await call("doctor", "POST", `/api/consultations/${c.body.id}/close`, undefined, DR1);
  await t.dispatcher.drain();
  const after = (await call("reception", "GET", "/api/queue?department=CONS")).body.queue;
  assert.ok(
    !after.some(
      (e: { patient: { identifier: string } }) => e.patient.identifier === patient.identifier,
    ),
  );
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'ConsultationClosed' and patient_id = $1",
    [patient.id],
  );
  assert.deepEqual(ev.rows[0].payload.diagnosisCodes, ["E11"]);
});

/* ------------------------------------------------------------------ F4-7 pièces jointes */

test("F4-7 : pièces jointes : types vérifiés sur le contenu, taille limitée, accès réservé aux rôles cliniques", async () => {
  const { consultation, patient } = await startConsultation(call, DR1, "Piece");
  const upload = (mime: string, data: Buffer, filename = "radio.png") =>
    call(
      "doctor",
      "POST",
      `/api/consultations/${consultation.id}/attachments`,
      { filename, mime, dataBase64: data.toString("base64") },
      DR1,
    );
  const ok = await upload("image/png", PNG);
  assert.equal(ok.status, 201, ok.raw);
  assert.equal(ok.body.size, PNG.length);
  assert.equal(
    (await upload("image/jpeg", PNG)).body.error.code,
    "mime_mismatch",
    "un PNG déguisé en JPEG est refusé",
  );
  assert.equal(
    (await upload("application/pdf", Buffer.from("%PDF-1.4 test"), "a.pdf")).status,
    201,
  );
  assert.equal((await upload("text/html", Buffer.from("<script>"), "x.html")).status, 415);
  const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 7)]);
  assert.equal((await upload("image/png", big)).status, 413);
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/consultations/${consultation.id}/attachments`,
        { filename: "v.png", mime: "image/png", dataBase64: "" },
        DR1,
      )
    ).status,
    400,
  );

  const file = await t.app.inject({
    method: "GET",
    url: `/api/attachments/${ok.body.id}`,
    headers: await t.as("doctor"),
  });
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["content-type"], "image/png");
  assert.ok(file.rawPayload.equals(PNG), "le fichier est restitué à l'identique");
  assert.equal((await call("lab", "GET", `/api/attachments/${ok.body.id}`)).status, 403);
  assert.equal((await call("cashier", "GET", `/api/attachments/${ok.body.id}`)).status, 403);
  const audit = await db.owner.query(
    "select count(*)::int as n from audit.log where action = 'attachment.read' and patient_id = $1",
    [patient.id],
  );
  assert.equal(audit.rows[0].n, 1);
  await assert.rejects(
    () => db.owner.query("delete from clinical.attachments where id = $1", [ok.body.id]),
    /ajout seul/,
  );
});

/* ------------------------------------------------------------------ F4-5 historique */

test("F4-5 : historique chronologique filtrable, avec consultations, ordonnances et demandes ; tracé", async () => {
  await openCash(call, "caisse-hist");
  const { patient, encounterId, consultation } = await startConsultation(call, DR1, "Histoire");
  await call(
    "doctor",
    "POST",
    `/api/consultations/${consultation.id}/diagnoses`,
    { code: "E11" },
    DR1,
  );
  const rx = await call(
    "doctor",
    "POST",
    "/api/prescriptions",
    {
      patientId: patient.id,
      consultationId: consultation.id,
      lines: [{ drugCode: "MET-500", dose: 1, perDay: 2, days: 30, route: "oral" }],
    },
    DR1,
  );
  assert.equal(rx.status, 201, rx.raw);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    { patientId: patient.id, encounterId, items: [{ actCode: "LAB-GLY", quantity: 1 }] },
    DR1,
  );
  assert.equal(order.status, 201, order.raw);
  await call("doctor", "POST", `/api/consultations/${consultation.id}/close`, undefined, DR1);

  const start = performance.now();
  const all = await call("doctor", "GET", `/api/patients/${patient.id}/history`);
  const ms = performance.now() - start;
  assert.ok(ms < 3000, `${ms} ms`);
  assert.deepEqual([...new Set(all.body.items.map((i: { kind: string }) => i.kind))].sort(), [
    "consultation",
    "order",
    "prescription",
  ]);
  const dates = all.body.items.map((i: { date: string }) => i.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "du plus récent au plus ancien");
  const onlyRx = await call(
    "doctor",
    "GET",
    `/api/patients/${patient.id}/history?kinds=prescription`,
  );
  assert.equal(onlyRx.body.items.length, 1);
  assert.equal(onlyRx.body.items[0].detail.lines[0], "Metformine 500 mg");
  assert.equal(
    (await call("doctor", "GET", `/api/patients/${patient.id}/history?kinds=autre`)).status,
    400,
  );
  assert.equal((await call("cashier", "GET", `/api/patients/${patient.id}/history`)).status, 403);
  assert.equal(
    (await call("pharmacy", "GET", `/api/patients/${patient.id}/history`)).status,
    403,
    "la pharmacie ne lit pas tout le dossier",
  );
  const merged = await newPatient(call, "Fusion");
  await call("admin", "POST", "/api/patients/merge", {
    survivorId: patient.id,
    mergedId: merged.id,
    reason: "même personne",
  });
  assert.equal(
    (await call("doctor", "GET", `/api/patients/${merged.id}/history`)).body.items.length,
    all.body.items.length,
    "l'historique suit la fusion",
  );
  const audit = await db.owner.query(
    "select count(*)::int as n from audit.log where action = 'history.read' and patient_id = $1",
    [patient.id],
  );
  assert.ok(audit.rows[0].n >= 3);
});

test("la consultation d'une admission se retrouve à partir de l'admission (file d'attente)", async () => {
  const c = await startConsultation(call, DR1, "ParAdmission");
  const found = await call(
    "doctor",
    "GET",
    `/api/encounters/${c.encounterId}/consultation`,
    undefined,
    DR1,
  );
  assert.equal(found.status, 200, found.raw);
  assert.equal(found.body.id, c.consultation.id);
  assert.equal(
    (
      await call(
        "doctor",
        "GET",
        "/api/encounters/00000000-0000-4000-8000-000000000000/consultation",
        undefined,
        DR1,
      )
    ).status,
    404,
  );
  assert.equal(
    (await call("cashier", "GET", `/api/encounters/${c.encounterId}/consultation`)).status,
    403,
  );
});
