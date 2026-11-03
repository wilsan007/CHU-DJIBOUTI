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

const sha = createHash("sha256").update(json).digest("hex");
console.log(`Jeu de données fictif écrit dans ${file}`);
console.log(
  `patients=${dataset.patients.length} rendez-vous=${dataset.appointments.length} ` +
    `ordonnances=${dataset.prescriptions.length} analyses=${dataset.labOrders.length}`,
);
console.log(`sha256=${sha}`);
