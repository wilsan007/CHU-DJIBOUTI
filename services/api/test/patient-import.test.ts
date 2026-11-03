import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import { makeCaller, newPatient, type Caller } from "./support/scenario.ts";

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

const HEAD = "id_externe,prenom,nom,sexe,date_naissance,age_estime,telephone\n";

test("reprise de l'ancien registre : essai sans écriture, puis application ; rejouable ; doublons et lignes fausses rendus", async () => {
  const existing = await newPatient(call, "Existant");
  void existing;
  const row = (await call("reception", "GET", `/api/patients/${existing.id}`)).body;
  const csv =
    HEAD +
    "A-1,Amina,Hassan,F,1990-02-03,,0025377000001\n" + // saine
    "A-2,Omar,Youssouf,H,,34,\n" + // âge estimé, sans téléphone
    `A-3,${row.givenName},${row.familyName},F,${row.birthDate},,\n` + // très proche d'un dossier existant
    "A-4,Sans,Sexe,?,1980-01-01,,\n" + // sexe illisible
    "A-5,Futur,Ne,F,2999-01-01,,\n" + // naissance dans le futur
    ",Sans,Identifiant,F,1980-01-01,,\n" + // identifiant d'origine manquant
    "A-1,Repete,Fichier,F,1970-01-01,,\n" + // id répété
    "A-8,Amina,Hassan,F,1990-02-03,,\n"; // même personne que la ligne A-1

  const forbidden = await call("doctor", "POST", "/api/patients/import", csv);
  assert.equal(forbidden.status, 403, "réservé à l'administrateur");

  const dry = await call("admin", "POST", "/api/patients/import", csv);
  assert.equal(dry.status, 200, dry.raw);
  assert.equal(dry.body.applied, false);
  assert.equal(dry.body.total, 8);
  assert.equal(dry.body.created, 2, "A-1 et A-2 seraient créées");
  assert.deepEqual(
    dry.body.invalid.map((x: { line: number }) => x.line),
    [5, 6, 7, 8],
    "lignes illisibles, avec leur numéro de ligne du fichier",
  );
  assert.equal(dry.body.duplicates.length, 2);
  assert.equal(dry.body.duplicates[0].externalId, "A-3");
  assert.equal(dry.body.duplicates[0].candidates[0].identifier, existing.identifier);
  assert.match(
    dry.body.duplicates[1].candidates[0].identifier,
    /^\d{6}$/,
    "la ressemblance avec la ligne A-1 du même fichier est vue dès l'essai",
  );
  assert.equal(dry.body.duplicates[1].candidates[0].name, "Amina Hassan");
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int n from identity.patients where external_id is not null",
      )
    ).rows[0].n,
    0,
    "l'essai n'écrit rien",
  );

  const real = await call("admin", "POST", "/api/patients/import?apply=true", csv);
  assert.equal(real.body.created, 2);
  const made = await db.owner.query(
    "select external_id, given_name, age_estimated, phone from identity.patients where external_id is not null order by external_id",
  );
  assert.deepEqual(
    made.rows.map((r) => r.external_id),
    ["A-1", "A-2"],
  );
  assert.equal(made.rows[1].age_estimated, true);

  const again = await call("admin", "POST", "/api/patients/import?apply=true", csv);
  assert.equal(again.body.created, 0, "rejouer le même fichier ne crée rien");
  assert.equal(again.body.alreadyImported, 2);
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int n from identity.patients where external_id is not null",
      )
    ).rows[0].n,
    2,
  );
  assert.ok(
    (await db.owner.query("select 1 from audit.log where action = 'patient.import'")).rowCount ===
      2,
    "reprise tracée",
  );

  assert.equal(
    (await call("admin", "POST", "/api/patients/import", "a,b\n1,2\n")).body.error.code,
    "bad_header",
  );
  assert.equal(
    (await call("admin", "POST", "/api/patients/import", { x: 1 })).status,
    400,
    "corps non CSV refusé",
  );
});
