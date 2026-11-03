import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANALYTES } from "../src/data.ts";
import { ageAt, flagFor, generateDataset } from "../src/generate.ts";

const dataset = generateDataset();

test("200 patients fictifs par défaut, dont des homonymes volontaires", () => {
  assert.equal(dataset.patients.length, 200);
  const dups = dataset.patients.filter((p) => p.intentionalDuplicateOf);
  assert.equal(dups.length, 6);
});

test("mêmes options, même résultat octet pour octet ; autre graine, autre résultat", () => {
  const a = JSON.stringify(generateDataset());
  const b = JSON.stringify(generateDataset());
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify(generateDataset({ seed: 1 })));
});

test("tous les identifiants externes sont uniques et tout est marqué fictif", () => {
  const ids = [
    ...dataset.patients,
    ...dataset.appointments,
    ...dataset.prescriptions,
    ...dataset.labOrders,
  ].map((r) => {
    assert.equal(r.fictional, true);
    assert.match(r.externalId, /^TEST-[PARL]-\d{6}$/);
    return r.externalId;
  });
  assert.equal(new Set(ids).size, ids.length);
});

test("numéros de téléphone invalides à dessein et uniques", () => {
  const phones = dataset.patients.map((p) => p.phone);
  for (const phone of phones) assert.match(phone, /^00 \d\d \d\d \d\d$/);
  assert.equal(new Set(phones).size, phones.length);
});

test("âges réalistes entre 0 et 99 ans", () => {
  for (const p of dataset.patients) {
    const age = ageAt(p.birthDate, dataset.meta.referenceDate);
    assert.ok(age >= 0 && age <= 99, `${p.externalId} : âge ${age}`);
  }
});

test("chaque paire d'homonymes : même identité, naissance proche, autre numéro", () => {
  const byId = new Map(dataset.patients.map((p) => [p.externalId, p]));
  for (const copy of dataset.patients.filter((p) => p.intentionalDuplicateOf)) {
    const original = byId.get(copy.intentionalDuplicateOf as string);
    assert.ok(original);
    assert.equal(copy.givenName, original.givenName);
    assert.equal(copy.familyName, original.familyName);
    assert.equal(copy.sex, original.sex);
    assert.notEqual(copy.phone, original.phone);
    const gapDays =
      Math.abs(Date.parse(copy.birthDate) - Date.parse(original.birthDate)) / 86_400_000;
    assert.ok(gapDays <= 150);
  }
});

test("intégrité référentielle", () => {
  const patientIds = new Set(dataset.patients.map((p) => p.externalId));
  for (const r of [...dataset.appointments, ...dataset.prescriptions, ...dataset.labOrders]) {
    assert.ok(patientIds.has(r.patientId), `${r.externalId} référence un patient absent`);
  }
  assert.ok(dataset.appointments.length > 0);
  assert.ok(dataset.prescriptions.length > 0);
  assert.ok(dataset.labOrders.length > 0);
});

test("aucune ordonnance fictive en conflit avec une allergie", () => {
  const byId = new Map(dataset.patients.map((p) => [p.externalId, p]));
  for (const rx of dataset.prescriptions) {
    const patient = byId.get(rx.patientId);
    assert.ok(patient);
    if (patient.allergies.includes("penicillin")) {
      for (const line of rx.lines) assert.ok(!/amoxicilline/i.test(line.drug));
    }
    assert.ok(rx.lines.length >= 1);
  }
});

test("les drapeaux des résultats d'analyse sont cohérents avec les valeurs", () => {
  let critical = 0;
  for (const order of dataset.labOrders) {
    for (const r of order.results) {
      const analyte = ANALYTES.find((a) => a.code === r.code);
      assert.ok(analyte);
      assert.equal(r.flag, flagFor(analyte, r.value));
      if (r.flag === "critical") critical += 1;
    }
  }
  assert.ok(critical > 0, "le jeu doit contenir au moins un résultat critique pour les tests");
});

test("l'outil en ligne de commande produit deux fois exactement le même fichier", () => {
  const dir = mkdtempSync(join(tmpdir(), "chu-seed-"));
  try {
    const run = () => {
      execFileSync("node", ["tools/seed/src/cli.ts", "--out", dir], { stdio: "pipe" });
      return createHash("sha256")
        .update(readFileSync(join(dir, "dataset.json")))
        .digest("hex");
    };
    assert.equal(run(), run());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
