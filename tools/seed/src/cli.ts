import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_OPTIONS, generateDataset } from "./generate.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "tools/seed/out" },
    count: { type: "string", default: String(DEFAULT_OPTIONS.count) },
    seed: { type: "string", default: String(DEFAULT_OPTIONS.seed) },
    "reference-date": { type: "string", default: DEFAULT_OPTIONS.referenceDate },
    "duplicate-pairs": { type: "string", default: String(DEFAULT_OPTIONS.duplicatePairs) },
  },
});

const dataset = generateDataset({
  count: Number(values.count),
  seed: Number(values.seed),
  referenceDate: String(values["reference-date"]),
  duplicatePairs: Number(values["duplicate-pairs"]),
});

const json = `${JSON.stringify(dataset, null, 2)}\n`;
const outDir = String(values.out);
mkdirSync(outDir, { recursive: true });
const file = join(outDir, "dataset.json");
writeFileSync(file, json, "utf8");

// Fichier d'import prêt pour POST /api/patients/import (reprise de l'ancien registre) : sert à la formation et aux essais.
const importHeader = "id_externe,prenom,nom,sexe,date_naissance,age_estime,telephone";
const importRows = dataset.patients.map((p) =>
  [
    p.externalId,
    p.givenName,
    p.familyName,
    p.sex === "female" ? "F" : "H",
    p.birthDate,
    "",
    "",
  ].join(","),
);
writeFileSync(
  join(outDir, "patients-import.csv"),
  `${[importHeader, ...importRows].join("\n")}\n`,
  "utf8",
);
console.log(
  `Fichier d'import des patients fictifs écrit dans ${join(outDir, "patients-import.csv")}`,
);

const sha = createHash("sha256").update(json).digest("hex");
console.log(`Jeu de données fictif écrit dans ${file}`);
console.log(
  `patients=${dataset.patients.length} rendez-vous=${dataset.appointments.length} ` +
    `ordonnances=${dataset.prescriptions.length} analyses=${dataset.labOrders.length}`,
);
console.log(`sha256=${sha}`);
