import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { parseCsv } from "../../common/csv.ts";
import { withTransaction, type Db } from "../../db.ts";
import { DomainError } from "../../errors.ts";
import type { Patient } from "./types.ts";
import { CreatePatientSchema, type CreatePatientInput } from "./schemas.ts";
import { createPatientIn } from "./service.ts";

export const MAX_IMPORT_ROWS = 5000;
const HEADER = ["id_externe", "prenom", "nom", "sexe", "date_naissance", "age_estime", "telephone"];

export interface PatientImportReport {
  applied: boolean;
  total: number;
  created: number;
  alreadyImported: number;
  invalid: { line: number; errors: string[] }[];
  /** Lignes laissées de côté : un dossier très proche existe déjà. À trancher par une personne (même patient ou non). */
  duplicates: {
    line: number;
    externalId: string;
    candidates: { identifier: string; name: string }[];
  }[];
}

const SEX: Record<string, "female" | "male"> = {
  f: "female",
  femme: "female",
  female: "female",
  h: "male",
  m: "male",
  homme: "male",
  male: "male",
};

/**
 * Reprise des patients de l'ancien registre (papier saisi, tableur) : une ligne par patient, rejouable.
 * Par défaut c'est un ESSAI (rien n'est écrit) ; `apply` crée les lignes saines. Un identifiant d'origine déjà repris
 * est ignoré (rejouer le même fichier ne crée rien en double) ; un dossier proche d'un existant n'est JAMAIS fusionné ni
 * créé en silence : la ligne est rendue pour décision humaine.
 */
export async function importPatients(
  db: Db,
  ctx: RequestContext,
  csv: string,
  options: { apply: boolean },
): Promise<PatientImportReport> {
  const rows = parseCsv(csv);
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string): number => head.indexOf(name);
  for (const required of ["id_externe", "prenom", "nom", "sexe"])
    if (col(required) < 0)
      throw new DomainError(
        "bad_header",
        `Colonne « ${required} » absente. Colonnes attendues : ${HEADER.join(", ")}.`,
        400,
      );
  if (rows.length > MAX_IMPORT_ROWS)
    throw new DomainError("too_many_rows", `Au plus ${MAX_IMPORT_ROWS} lignes par fichier.`, 400);

  const report: PatientImportReport = {
    applied: options.apply,
    total: rows.length,
    created: 0,
    alreadyImported: 0,
    invalid: [],
    duplicates: [],
  };
  const seen = new Set<string>();
  const valid: { line: number; externalId: string; input: CreatePatientInput }[] = [];
  for (const [i, r] of rows.entries()) {
    const line = i + 2; // ligne du fichier (l'en-tête est la ligne 1)
    const get = (name: string): string => (r[col(name)] ?? "").trim();
    const externalId = get("id_externe");
    const errors: string[] = [];
    if (!externalId) errors.push("id_externe obligatoire (identifiant dans l'ancien registre)");
    if (seen.has(externalId)) errors.push("id_externe répété dans le fichier");
    seen.add(externalId);
    const sex = SEX[get("sexe").toLowerCase()];
    if (!sex) errors.push("sexe : F, H, M, femme, homme, female ou male");
    const birth = get("date_naissance");
    const age = get("age_estime");
    const parsed = CreatePatientSchema.safeParse({
      givenName: get("prenom"),
      familyName: get("nom"),
      sex,
      ...(birth ? { birthDate: birth } : {}),
      ...(!birth && age ? { estimatedAge: Number(age) } : {}),
      ...(get("telephone") ? { phone: get("telephone") } : {}),
      externalId,
    });
    if (!parsed.success)
      errors.push(...parsed.error.issues.map((x) => `${x.path.join(".")} : ${x.message}`));
    if (errors.length > 0 || !parsed.success) report.invalid.push({ line, errors });
    else valid.push({ line, externalId, input: parsed.data });
  }

  // Tout le fichier dans UNE transaction. L'essai suit exactement le même chemin que l'application (mêmes contrôles,
  // y compris les ressemblances entre deux lignes du fichier) puis annule : ce qu'il annonce est ce qui arrivera.
  const ROLLBACK = new Error("essai : annulation voulue");
  try {
    await withTransaction(db, async (tx) => {
      for (const v of valid) {
        await tx.query("savepoint row");
        try {
          const r = await createPatientIn(tx, ctx, v.input);
          await tx.query("release savepoint row");
          if (r.created) report.created += 1;
          else report.alreadyImported += 1;
        } catch (error) {
          await tx.query("rollback to savepoint row");
          if (!(error instanceof DomainError && error.code === "possible_duplicates")) throw error;
          const found =
            (error.details as { candidates?: { patient: Patient }[] } | undefined)?.candidates ??
            [];
          report.duplicates.push({
            line: v.line,
            externalId: v.externalId,
            candidates: found.map((c) => ({
              identifier: c.patient.identifier,
              name: [c.patient.givenName, c.patient.familyName].filter(Boolean).join(" "),
            })),
          });
        }
      }
      if (options.apply)
        await writeAudit(tx, ctx, {
          action: "patient.import",
          entityType: "patient_import",
          detail: {
            total: report.total,
            created: report.created,
            alreadyImported: report.alreadyImported,
            duplicates: report.duplicates.length,
            invalid: report.invalid.length,
          },
        });
      else throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return report;
}
