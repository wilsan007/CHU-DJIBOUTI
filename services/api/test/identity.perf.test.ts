import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";

/**
 * Critère de l'histoire F1-2 : recherche en moins de 2 secondes sur 100 000 patients fictifs.
 */
const TOTAL = 100_000;
const LIMIT_MS = 2000;

let db: TestDatabase;
let t: TestApp;

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  await db.owner.query(
    `with names as (
       select array['fatouma','hodan','amina','khadija','samira','ayan','idil','mariam','asha','nimo',
                    'abdi','mohamed','ahmed','ismael','houssein','omar','ali','abdillahi','moussa','kadar'] as given,
              array['dirir','warsama','robleh','houssein','ibrahim','ali','moussa','hassan','osman','farah',
                    'doualeh','abdallah','guedi','barkhad','mahamoud','djama','awaleh','elmi'] as fam
     ), rows as (
       select i,
              given[1 + (i * 7) % 20] as g,
              fam[1 + (i * 11) % 18] as f1,
              fam[1 + (i * 13 + i / 18) % 18] as f2
         from generate_series(1, ${TOTAL}) as i, names
     )
     insert into identity.patients
       (identifier, kind, given_name, family_name, sex, birth_date, phone, phone_digits, name_norm, created_by)
     select lpad(nextval('identity.patient_number_seq')::text, 6, '0'), 'regular',
            g, f1 || ' ' || f2,
            case when i % 2 = 0 then 'female' else 'male' end,
            date '1930-01-01' + (i % 30000),
            '00 ' || lpad(i::text, 6, '0'), '00' || lpad(i::text, 6, '0'),
            (select string_agg(tok, ' ' order by tok) from unnest(array[g, f1, f2]) as tok),
            'perf'
       from rows`,
  );
  await db.owner.query("analyze identity.patients");
});
after(async () => {
  await t.close();
  await db.drop();
});

async function timed(url: string): Promise<{ ms: number; count: number }> {
  const start = performance.now();
  const res = await t.app.inject({ method: "GET", url, headers: await t.as("reception") });
  const ms = performance.now() - start;
  assert.equal(res.statusCode, 200, url);
  return { ms, count: res.json().results.length };
}

test(`F1-2 : ${TOTAL} patients en base`, async () => {
  const n = await db.owner.query("select count(*)::int as n from identity.patients");
  assert.equal(n.rows[0].n, TOTAL);
});

test(`F1-2 : chaque type de recherche répond en moins de ${LIMIT_MS} ms sur ${TOTAL} patients`, async () => {
  const queries: [string, string][] = [
    ["nom et prénom", "/api/patients?q=Fatouma%20Dirir"],
    ["prénom seul", "/api/patients?q=Hodan"],
    ["faute de frappe", "/api/patients?q=Fatuma%20Warsama"],
    ["ordre inversé", "/api/patients?q=Robleh%20Abdi"],
    ["téléphone (fin)", "/api/patients?q=012345"],
    ["identifiant", "/api/patients?q=054321"],
    ["date de naissance", "/api/patients?q=1960-03-04"],
  ];
  for (const [label, url] of queries) {
    // Une première requête chauffe les caches ; on mesure la seconde, comme en usage réel.
    await timed(url);
    const { ms, count } = await timed(url);
    console.log(`  ${label} : ${ms.toFixed(0)} ms, ${count} résultat(s)`);
    assert.ok(ms < LIMIT_MS, `${label} : ${ms.toFixed(0)} ms`);
    assert.ok(count > 0, `${label} : aucun résultat`);
  }
});

test(`la détection de doublon à la création reste sous ${LIMIT_MS} ms sur ${TOTAL} patients`, async () => {
  const start = performance.now();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/patients",
    headers: await t.as("reception"),
    payload: {
      givenName: "Fatouma",
      familyName: "Dirir Warsama",
      sex: "female",
      birthDate: "1981-03-02",
      phone: "00 99 99 99",
    },
  });
  const ms = performance.now() - start;
  console.log(
    `  création avec contrôle de doublon : ${ms.toFixed(0)} ms (statut ${res.statusCode})`,
  );
  assert.ok([201, 409].includes(res.statusCode));
  assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)} ms`);
});
