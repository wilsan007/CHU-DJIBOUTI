// Reprise de patients depuis un fichier (jeu fictif du générateur) contre la vraie API : essai, application, rejeu,
// doublons voulus du jeu (6 paires d'homonymes) rendus pour décision, patients retrouvables ensuite à l'accueil.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { api } from "./lib.mjs";

const dir = `/tmp/seed-import-${Date.now()}`;
execFileSync(
  process.execPath,
  ["tools/seed/src/cli.ts", "--out", dir, "--count", "60", "--seed", String(Date.now() % 100000)],
  { stdio: "ignore" },
);
const csv = readFileSync(`${dir}/patients-import.csv`, "utf8");
const lines = csv.trim().split("\n").length - 1;

const dry = (await api("dev-admin", "/api/patients/import", { method: "POST", csv, expect: 200 }))
  .data;
assert.equal(dry.applied, false);
assert.equal(dry.total, lines);
assert.equal(dry.invalid.length, 0, JSON.stringify(dry.invalid.slice(0, 3)));
assert.ok(dry.duplicates.length >= 1, "les homonymes voulus du jeu sont signalés dès l'essai");
const would = dry.created;
console.log(`  ✔ essai : ${would} seraient créés, ${dry.duplicates.length} à trancher, rien écrit`);

const real = (
  await api("dev-admin", "/api/patients/import?apply=true", { method: "POST", csv, expect: 200 })
).data;
assert.equal(
  real.created + real.duplicates.length + real.alreadyImported,
  lines,
  "chaque ligne a un sort",
);
assert.ok(
  real.created >= would - 6,
  "à peu près ce que l'essai annonçait (les paires du même fichier se révèlent à l'application)",
);
console.log(
  `  ✔ application : ${real.created} créés, ${real.duplicates.length} laissés pour décision`,
);

const again = (
  await api("dev-admin", "/api/patients/import?apply=true", { method: "POST", csv, expect: 200 })
).data;
assert.equal(again.created, 0, "rejouer le fichier ne crée rien");
assert.equal(again.alreadyImported, real.created);
console.log(`  ✔ rejeu : 0 créé, ${again.alreadyImported} reconnus comme déjà repris`);

const first = csv.trim().split("\n")[1].split(",");
const found = (
  await api("dev-reception", `/api/patients?q=${encodeURIComponent(first[2])}`, { expect: 200 })
).data.results;
assert.ok(
  found.some((p) => p.givenName === first[1] || p.familyName === first[2]),
  "un patient repris est retrouvable à l'accueil",
);
assert.equal(
  (await api("dev-reception", "/api/patients/import", { method: "POST", csv })).status,
  403,
  "réservé à l'administrateur",
);
console.log("OK : reprise des patients vérifiée contre la vraie API.");
