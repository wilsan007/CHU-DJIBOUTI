import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { envExampleValueLines, findSecret, isForbiddenPath } from "./rules.ts";

const MAX_SCANNED_BYTES = 1_000_000;

// Fichiers suivis par Git, plus ceux qui seraient ajoutés (non ignorés) : on contrôle ce qui partirait.
const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((p) => p !== "");

const problems: string[] = [];

for (const path of listed) {
  if (isForbiddenPath(path)) {
    problems.push(`${path} : fichier interdit dans le dépôt (secret, clé ou sauvegarde)`);
    continue;
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    continue; // fichier supprimé mais encore indexé
  }
  if (size > MAX_SCANNED_BYTES) continue;
  const text = readFileSync(path, "utf8");
  const secret = findSecret(text);
  if (secret) problems.push(`${path} : contient un secret probable (${secret})`);
  if (/(^|\/)\.env\.example$/.test(path)) {
    for (const line of envExampleValueLines(text)) {
      problems.push(`${path}:${line} : .env.example ne doit contenir aucune valeur`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Contrôle du dépôt : ${listed.length} fichiers, aucun secret détecté.`);
