import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Role } from "../src/auth/permissions.ts";
import { createPatient } from "../src/modules/identity/service.ts";
import { cardPayload, parseCardPayload } from "../src/modules/identity/card.ts";
import { normalizeName } from "../src/modules/identity/normalize.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";

let db: TestDatabase;
let t: TestApp;
before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
});
after(async () => {
  await t.close();
  await db.drop();
});

let phoneCounter = 0;
const nextPhone = () =>
  `00 00 ${String(Math.floor(++phoneCounter / 100)).padStart(2, "0")} ${String(phoneCounter % 100).padStart(2, "0")}`;

async function call(method: "GET" | "POST", url: string, role: Role, payload?: unknown) {
  return t.app.inject({
    method,
    url,
    headers: await t.as(role),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function create(overrides: Record<string, unknown> = {}, role: Role = "reception") {
  const res = await call("POST", "/api/patients", role, {
    givenName: "Test",
    familyName: "Patient",
    sex: "female",
    birthDate: "1990-05-10",
    phone: nextPhone(),
    confirmNotDuplicate: true,
    ...overrides,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

/* ------------------------------------------------------------------ F1-1 */

test("F1-1 : création avec identifiant automatique, audit et événement dans la même transaction", async () => {
  const p = await create({
    givenName: "Fatouma",
    familyName: "Ahmed Dirir",
    birthDate: "1981-03-02",
  });
  assert.match(p.identifier, /^\d{6}$/);
  assert.equal(p.kind, "regular");
  assert.equal(p.ageEstimated, false);
  const audit = await db.owner.query(
    "select action, patient_id, actor_roles from audit.log where patient_id = $1",
    [p.id],
  );
  assert.equal(audit.rows[0].action, "patient.create");
  assert.deepEqual(audit.rows[0].actor_roles, ["reception"]);
  const ev = await db.owner.query("select type, payload from events.outbox where patient_id = $1", [
    p.id,
  ]);
  assert.equal(ev.rows[0].type, "PatientCreated");
  assert.equal(ev.rows[0].payload.identifier, p.identifier);
  assert.equal(ev.rows[0].payload.fhirResource, `Patient/${p.id}`);
});

test("F1-1 : champs obligatoires et dates invalides refusés", async () => {
  const base = {
    givenName: "A",
    familyName: "B",
    sex: "male",
    birthDate: "1990-01-01",
    phone: "00 00 00 99",
  };
  const bad: [string, Record<string, unknown>][] = [
    ["sans nom", { ...base, familyName: "" }],
    ["sexe inconnu", { ...base, sex: "x" }],
    ["ni date ni âge", { ...base, birthDate: undefined }],
    ["date et âge ensemble", { ...base, estimatedAge: 30 }],
    ["date dans le futur", { ...base, birthDate: "2999-01-01" }],
    ["date inexistante", { ...base, birthDate: "2020-02-30" }],
    ["âge absurde", { ...base, birthDate: undefined, estimatedAge: 200 }],
  ];
  for (const [label, payload] of bad) {
    const res = await call("POST", "/api/patients", "reception", payload);
    assert.equal(res.statusCode, 400, label);
    assert.equal(res.json().error.code, "validation_error", label);
  }
});

test("F1-1 : un patient sans téléphone est accepté ; les doublons sont détectés par le nom et la naissance", async () => {
  const body = {
    givenName: "Sans",
    familyName: "Telephone",
    sex: "female",
    birthDate: "1975-05-05",
  };
  const first = await call("POST", "/api/patients", "reception", body);
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().phone, null);
  const again = await call("POST", "/api/patients", "reception", body);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "possible_duplicates");
  const invalid = await call("POST", "/api/patients", "reception", {
    ...body,
    familyName: "Autre",
    phone: "1",
  });
  assert.equal(invalid.statusCode, 400, "un numéro fourni mais invalide reste refusé");
});

test("F1-1 : âge estimé marqué comme tel", async () => {
  const p = await create({ birthDate: undefined, estimatedAge: 40 });
  assert.equal(p.ageEstimated, true);
  assert.equal(Number(p.birthDate.slice(0, 4)), new Date().getUTCFullYear() - 40);
});

test("F1-1 : identifiants uniques, croissants, jamais réutilisés", async () => {
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(Number((await create()).identifier));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    ids,
  );
  // Un échec de création consomme un numéro : le numéro n'est jamais redonné.
  const before = Number((await create()).identifier);
  await call("POST", "/api/patients", "reception", { givenName: "x" });
  const after = Number((await create()).identifier);
  assert.ok(after > before);
});

test("F1-1 : aucune création sans événement ni audit (atomicité)", async () => {
  const iso = await createTestDatabase();
  try {
    await iso.owner.query("revoke insert on events.outbox from chu_app");
    await assert.rejects(() =>
      createPatient(
        iso.app,
        { user: { id: "u", name: "u", roles: ["reception"] }, requestId: "r" },
        {
          givenName: "A",
          familyName: "B",
          sex: "male",
          birthDate: "1990-01-01",
          phone: "00 00 00 77",
        },
      ),
    );
    const patients = await iso.owner.query("select count(*)::int as n from identity.patients");
    const audit = await iso.owner.query("select count(*)::int as n from audit.log");
    assert.equal(patients.rows[0].n, 0);
    assert.equal(audit.rows[0].n, 0);
  } finally {
    await iso.drop();
  }
});

test("F1-1 : l'identifiant d'origine est réservé à l'administration et rend la création idempotente", async () => {
  const payload = {
    givenName: "Import",
    familyName: "Fictif",
    sex: "male",
    birthDate: "1975-06-06",
    phone: "00 00 55 55",
    externalId: "TEST-P-000001",
  };
  const refused = await call("POST", "/api/patients", "reception", payload);
  assert.equal(refused.statusCode, 403);
  const first = await call("POST", "/api/patients", "admin", payload);
  const second = await call("POST", "/api/patients", "admin", payload);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().id, second.json().id);
});

/* ------------------------------------------------------------------ F1-2 */

test("F1-2 : recherche tolérante aux fautes, à l'ordre des mots, aux accents et à l'écriture arabe", async () => {
  const fatouma = await create({
    givenName: "Fatouma",
    familyName: "Ahmed Dirir",
    birthDate: "1981-03-02",
  });
  await create({ givenName: "Hodan", familyName: "Moussa Ibrahim", birthDate: "1996-08-20" });
  const ismael = await create({
    givenName: "Ismaël",
    familyName: "Kadar Robleh",
    birthDate: "1988-01-15",
  });
  const mohammed = await create({
    givenName: "Mohammed",
    familyName: "Said",
    birthDate: "1970-04-04",
  });
  const arabe = await create({
    givenName: "فاطمة",
    familyName: "أحمد ضرير",
    birthDate: "1982-02-02",
  });

  const find = async (q: string) => {
    const res = await call("GET", `/api/patients?q=${encodeURIComponent(q)}`, "reception");
    assert.equal(res.statusCode, 200, q);
    return res.json().results.map((r: { id: string }) => r.id) as string[];
  };
  assert.ok((await find("Fatouma")).includes(fatouma.id), "prénom seul");
  assert.ok((await find("Dirir Fatouma")).includes(fatouma.id), "ordre inversé");
  assert.ok((await find("Fatuma Dirir")).includes(fatouma.id), "faute de frappe");
  assert.ok((await find("ismael")).includes(ismael.id), "sans accent");
  assert.ok((await find("Mohamed")).includes(mohammed.id), "variante d'écriture");
  assert.ok((await find("فاطمة")).includes(arabe.id), "arabe");
  assert.ok((await find("فَاطِمَة")).includes(arabe.id), "arabe avec voyelles brèves");
  assert.ok(!(await find("Hodan")).includes(fatouma.id), "pas de faux résultat évident");
});

test("F1-2 : recherche par téléphone, identifiant et date de naissance", async () => {
  const p = await create({
    givenName: "Samira",
    familyName: "Farah",
    birthDate: "1999-09-09",
    phone: "00 12 34 56",
  });
  const idsFor = async (q: string) =>
    (await call("GET", `/api/patients?q=${encodeURIComponent(q)}`, "reception"))
      .json()
      .results.map((r: { id: string }) => r.id);
  assert.ok((await idsFor("00 12 34 56")).includes(p.id), "téléphone complet");
  assert.ok((await idsFor("123456")).includes(p.id), "fin du numéro");
  assert.ok((await idsFor(p.identifier)).includes(p.id), "identifiant");
  assert.ok((await idsFor(String(Number(p.identifier)))).includes(p.id), "identifiant sans zéros");
  assert.ok((await idsFor("09/09/1999")).includes(p.id), "date jj/mm/aaaa");
  assert.ok((await idsFor("1999-09-09")).includes(p.id), "date ISO");
});

test("F1-2 : requête trop courte refusée, limite respectée", async () => {
  const short = await call("GET", "/api/patients?q=a", "reception");
  assert.equal(short.statusCode, 400);
  for (let i = 0; i < 3; i += 1) await create({ givenName: "Limite", familyName: "Commune" });
  const res = await call("GET", "/api/patients?q=Limite%20Commune&limit=2", "reception");
  assert.equal(res.json().results.length, 2);
});

/* ------------------------------------------------------------------ F1-3 */

test("F1-3 : alerte de doublon, sans bloquer l'utilisateur", async () => {
  const original = await create({
    givenName: "Doublon",
    familyName: "Alerte Test",
    birthDate: "1980-06-01",
    phone: "00 77 00 01",
  });
  const dup = {
    givenName: "Doublon",
    familyName: "Alerte Test",
    sex: "female",
    birthDate: "1981-02-01",
    phone: "00 77 00 02",
  };
  const warned = await call("POST", "/api/patients", "reception", dup);
  assert.equal(warned.statusCode, 409);
  assert.equal(warned.json().error.code, "possible_duplicates");
  assert.equal(warned.json().error.details.candidates[0].patient.id, original.id);
  // L'utilisateur confirme : la création passe.
  const forced = await call("POST", "/api/patients", "reception", {
    ...dup,
    confirmNotDuplicate: true,
  });
  assert.equal(forced.statusCode, 201);
  const audit = await db.owner.query(
    "select detail from audit.log where patient_id = $1 and action = 'patient.create'",
    [forced.json().id],
  );
  assert.equal(audit.rows[0].detail.forcedDespiteDuplicates, true);
});

test("F1-3 : pas de fausse alerte pour un autre nom ou une autre génération", async () => {
  await create({
    givenName: "Unique",
    familyName: "Personne Un",
    birthDate: "1960-01-01",
    phone: "00 78 00 01",
  });
  const otherName = await call("POST", "/api/patients", "reception", {
    givenName: "Autre",
    familyName: "Gens Deux",
    sex: "male",
    birthDate: "1960-01-01",
    phone: "00 78 00 02",
  });
  assert.equal(otherName.statusCode, 201);
  const sameNameFarAge = await call("POST", "/api/patients", "reception", {
    givenName: "Unique",
    familyName: "Personne Un",
    sex: "female",
    birthDate: "1995-01-01",
    phone: "00 78 00 03",
  });
  assert.equal(sameNameFarAge.statusCode, 201);
});

test("F1-3 : même téléphone et nom proche : alerte", async () => {
  await create({
    givenName: "Samia",
    familyName: "Barkhad Tel",
    birthDate: "1970-01-01",
    phone: "00 79 00 01",
  });
  const res = await call("POST", "/api/patients", "reception", {
    givenName: "Samya",
    familyName: "Barkhad Tel",
    sex: "female",
    birthDate: "1990-01-01",
    phone: "00 79 00 01",
  });
  assert.equal(res.statusCode, 409);
});

/* ------------------------------------------------------------------ F1-4 */

test("F1-4 : fusion réservée à l'administration, l'ancien identifiant renvoie vers le nouveau", async () => {
  const keep = await create({ givenName: "Fusion", familyName: "Gardé" });
  const old = await create({ givenName: "Fusion", familyName: "Ancien" });
  const body = { survivorId: keep.id, mergedId: old.id, reason: "même personne" };
  assert.equal((await call("POST", "/api/patients/merge", "reception", body)).statusCode, 403);
  assert.equal((await call("POST", "/api/patients/merge", "doctor", body)).statusCode, 403);
  const merged = await call("POST", "/api/patients/merge", "admin", body);
  assert.equal(merged.statusCode, 200);
  assert.equal(merged.json().id, keep.id);

  const viaOld = await call("GET", `/api/patients/${old.identifier}`, "doctor");
  assert.equal(viaOld.json().id, keep.id);
  assert.equal(viaOld.json().redirectedFrom, old.identifier);
  const viaOldUuid = await call("GET", `/api/patients/${old.id}`, "doctor");
  assert.equal(viaOldUuid.json().id, keep.id);

  const listed = await call("GET", "/api/patients?q=Fusion%20Ancien", "reception");
  assert.ok(
    !listed.json().results.some((r: { id: string }) => r.id === old.id),
    "le dossier fusionné n'est plus listé",
  );

  const audit = await db.owner.query(
    "select detail, actor_roles from audit.log where action = 'patient.merge' and patient_id = $1",
    [keep.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].detail.mergedId, old.id);
  assert.equal(audit.rows[0].detail.reason, "même personne");
  const ev = await db.owner.query(
    "select type, payload from events.outbox where type = 'PatientMerged' and patient_id = $1",
    [keep.id],
  );
  assert.equal(ev.rows[0].payload.mergedIdentifier, old.identifier);
});

test("F1-4 : fusions invalides refusées", async () => {
  const a = await create();
  const b = await create();
  const self = await call("POST", "/api/patients/merge", "admin", {
    survivorId: a.id,
    mergedId: a.id,
    reason: "test",
  });
  assert.equal(self.statusCode, 400);
  await call("POST", "/api/patients/merge", "admin", {
    survivorId: a.id,
    mergedId: b.id,
    reason: "test",
  });
  const again = await call("POST", "/api/patients/merge", "admin", {
    survivorId: a.id,
    mergedId: b.id,
    reason: "test",
  });
  assert.equal(again.statusCode, 409);
  const missing = await call("POST", "/api/patients/merge", "admin", {
    survivorId: a.id,
    mergedId: "00000000-0000-4000-8000-000000000000",
    reason: "test",
  });
  assert.equal(missing.statusCode, 404);
  const noReason = await call("POST", "/api/patients/merge", "admin", {
    survivorId: a.id,
    mergedId: b.id,
  });
  assert.equal(noReason.statusCode, 400);
});

test("F1-4 : deux fusions simultanées d'un même dossier : une seule réussit", async () => {
  const a = await create();
  const b = await create();
  const c = await create();
  const results = await Promise.all([
    call("POST", "/api/patients/merge", "admin", {
      survivorId: a.id,
      mergedId: c.id,
      reason: "course A",
    }),
    call("POST", "/api/patients/merge", "admin", {
      survivorId: b.id,
      mergedId: c.id,
      reason: "course B",
    }),
  ]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 409]);
});

/* ------------------------------------------------------------------ F1-5 */

test("F1-5 : patient inconnu en urgence, trois champs au plus, identifiant provisoire", async () => {
  const empty = await call("POST", "/api/patients/provisional", "nurse", {});
  assert.equal(empty.statusCode, 201);
  assert.match(empty.json().identifier, /^U-\d{6}$/);
  assert.equal(empty.json().kind, "provisional");
  const full = await call("POST", "/api/patients/provisional", "doctor", {
    sex: "male",
    estimatedAge: 30,
    note: "trouvé à l'entrée",
  });
  assert.equal(full.statusCode, 201);
  assert.equal(full.json().ageEstimated, true);
  const tooMany = await call("POST", "/api/patients/provisional", "doctor", {
    sex: "male",
    givenName: "X",
  });
  assert.equal(tooMany.statusCode, 400);
  const byId = await call("GET", `/api/patients?q=${empty.json().identifier}`, "reception");
  assert.equal(byId.json().results[0].id, empty.json().id);
});

test("F1-5 : rattachement à un vrai dossier sans perte d'historique", async () => {
  const provisional = (
    await call("POST", "/api/patients/provisional", "nurse", { sex: "female" })
  ).json();
  const real = await create({ givenName: "Rattache", familyName: "Vrai" });
  const refusedNurse = await call("POST", `/api/patients/${provisional.identifier}/link`, "nurse", {
    patientId: real.id,
  });
  assert.equal(refusedNurse.statusCode, 403);
  const linked = await call("POST", `/api/patients/${provisional.identifier}/link`, "reception", {
    patientId: real.id,
  });
  assert.equal(linked.statusCode, 200);
  assert.equal(linked.json().id, real.id);
  const viaProvisional = await call("GET", `/api/patients/${provisional.identifier}`, "doctor");
  assert.equal(viaProvisional.json().id, real.id);
  assert.equal(viaProvisional.json().redirectedFrom, provisional.identifier);
  const notProvisional = await call("POST", `/api/patients/${real.identifier}/link`, "reception", {
    patientId: real.id,
  });
  assert.equal(notProvisional.statusCode, 400);
});

/* ------------------------------------------------------------------ F1-6 */

test("F1-6 : le QR contient seulement l'identifiant et une clé de contrôle", async () => {
  const p = await create({ givenName: "Carte", familyName: "Qr" });
  const card = (await call("GET", `/api/patients/${p.id}/card`, "reception")).json();
  assert.equal(card.identifier, p.identifier);
  assert.match(card.payload, /^CHU1\.\d{6}\.\d{2}$/);
  assert.ok(!card.payload.toLowerCase().includes("carte"));
  const opened = await call("GET", `/api/cards/${card.payload}`, "doctor");
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.json().id, p.id);
  const audit = await db.owner.query(
    "select detail from audit.log where action = 'patient.read' and patient_id = $1 and detail->>'via' = 'card'",
    [p.id],
  );
  assert.equal(audit.rows.length, 1);
  const tampered = card.payload.replace(/\d{2}$/, (d: string) => (d === "00" ? "01" : "00"));
  assert.equal((await call("GET", `/api/cards/${tampered}`, "doctor")).statusCode, 400);
  assert.equal((await call("GET", "/api/cards/n-importe-quoi", "doctor")).statusCode, 400);
  assert.equal(
    (await call("GET", `/api/cards/${cardPayload("999999")}`, "doctor")).statusCode,
    404,
  );
});

test("F1-6 : la direction ne peut pas ouvrir un dossier par la carte", async () => {
  const p = await create();
  const card = cardPayload(p.identifier);
  assert.equal((await call("GET", `/api/cards/${card}`, "direction")).statusCode, 403);
});

/* ------------------------------------------------------------------ audit */

test("ouvrir un dossier est tracé : qui, quoi, quand, quel patient", async () => {
  const p = await create({ givenName: "Audit", familyName: "Lecture" });
  const res = await t.app.inject({
    method: "GET",
    url: `/api/patients/${p.identifier}`,
    headers: await t.as("doctor"),
  });
  const row = await db.owner.query(
    "select actor_id, actor_roles, action, patient_id, request_id, at from audit.log where action = 'patient.read' and patient_id = $1",
    [p.id],
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].actor_id, "sub-doctor");
  assert.deepEqual(row.rows[0].actor_roles, ["doctor"]);
  assert.equal(row.rows[0].request_id, res.headers["x-request-id"]);
  assert.ok(row.rows[0].at instanceof Date);
});

/* ------------------------------------------------------------------ unités */

test("normalisation : accents, casse, ordre des mots, arabe", () => {
  assert.equal(normalizeName("Ismaël", "Kadar-Robleh"), "ismael kadar robleh");
  assert.equal(normalizeName("Dirir", "Fatouma"), normalizeName("fatouma", "DIRIR"));
  assert.equal(normalizeName("فَاطِمَة"), normalizeName("فاطمة"));
  assert.equal(normalizeName("أحمد"), normalizeName("احمد"));
});

test("carte : la clé détecte une erreur d'un caractère", () => {
  const payload = cardPayload("000123");
  assert.equal(parseCardPayload(payload), "000123");
  assert.equal(parseCardPayload(payload.replace("000123", "000124")), null);
  assert.equal(parseCardPayload("CHU1.000123"), null);
});
