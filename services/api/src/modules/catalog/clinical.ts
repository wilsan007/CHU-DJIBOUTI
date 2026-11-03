import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { parseCsv } from "../../common/csv.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import type { ImportReport } from "./service.ts";

/* ------------------------------------------------------------------ diagnostics CIM-10 */

export interface Diagnosis {
  code: string;
  labelFr: string;
  labelAr: string;
}

export async function searchDiagnoses(db: Db, q: string, limit = 15): Promise<Diagnosis[]> {
  const res = await db.query<{ code: string; label_fr: string; label_ar: string }>(
    `select code, label_fr, label_ar from catalog.diagnoses
      where active and (code ilike $1 || '%'
            or unaccent(lower(label_fr)) like '%' || unaccent(lower($1)) || '%'
            or label_ar like '%' || $1 || '%')
      order by (code ilike $1 || '%') desc, length(label_fr), code limit $2`,
    [q.trim(), limit],
  );
  return res.rows.map((r) => ({ code: r.code, labelFr: r.label_fr, labelAr: r.label_ar }));
}

export async function requireDiagnosis(tx: Tx | Db, code: string): Promise<Diagnosis> {
  const res = await tx.query<{ code: string; label_fr: string; label_ar: string; active: boolean }>(
    "select code, label_fr, label_ar, active from catalog.diagnoses where code = $1",
    [code],
  );
  const r = res.rows[0];
  if (!r) throw notFound(`Diagnostic ${code}`);
  if (!r.active)
    throw new DomainError("diagnosis_inactive", `Le diagnostic ${code} n'est plus proposé.`, 409);
  return { code: r.code, labelFr: r.label_fr, labelAr: r.label_ar };
}

/* ------------------------------------------------------------------ médicaments */

export interface Drug {
  code: string;
  dci: string;
  form: string;
  strength: string;
  labelAr: string | null;
  allergyClass: string | null;
  interactionClass: string | null;
  active: boolean;
}

interface DrugRow {
  code: string;
  dci: string;
  form: string;
  strength: string;
  label_ar: string | null;
  allergy_class: string | null;
  interaction_class: string | null;
  active: boolean;
}

const toDrug = (r: DrugRow): Drug => ({
  code: r.code,
  dci: r.dci,
  form: r.form,
  strength: r.strength,
  labelAr: r.label_ar,
  allergyClass: r.allergy_class,
  interactionClass: r.interaction_class,
  active: r.active,
});

export async function searchDrugs(db: Db, q: string, limit = 15): Promise<Drug[]> {
  const res = await db.query<DrugRow>(
    `select code, dci, form, strength, label_ar, allergy_class, interaction_class, active from catalog.drugs
      where active and (unaccent(lower(dci)) like '%' || unaccent(lower($1)) || '%' or code ilike $1 || '%')
      order by dci, strength limit $2`,
    [q.trim(), limit],
  );
  return res.rows.map(toDrug);
}

export async function requireDrug(tx: Tx | Db, code: string): Promise<Drug> {
  const res = await tx.query<DrugRow>(
    "select code, dci, form, strength, label_ar, allergy_class, interaction_class, active from catalog.drugs where code = $1",
    [code],
  );
  const r = res.rows[0];
  if (!r) throw notFound(`Médicament ${code}`);
  if (!r.active)
    throw new DomainError("drug_inactive", `Le médicament ${code} n'est plus proposé.`, 409);
  return toDrug(r);
}

export interface StandardDosage {
  dose: number;
  perDay: number;
  days: number;
  route: string;
  validatedBy: string;
  validatedOn: string;
}

/** Posologies standard : seulement celles validées par un pharmacien ou un médecin. */
export async function standardDosages(tx: Tx | Db, drugCode: string): Promise<StandardDosage[]> {
  const res = await tx.query<{
    dose: string;
    per_day: number;
    days: number;
    route: string;
    validated_by: string;
    validated_on: string;
  }>(
    `select dose, per_day, days, route, validated_by, validated_on::text from catalog.dosage_templates
      where drug_code = $1 order by id`,
    [drugCode],
  );
  return res.rows.map((r) => ({
    dose: Number(r.dose),
    perDay: r.per_day,
    days: r.days,
    route: r.route,
    validatedBy: r.validated_by,
    validatedOn: r.validated_on,
  }));
}

export async function saveStandardDosage(
  db: Db,
  ctx: RequestContext,
  drugCode: string,
  input: {
    dose: number;
    perDay: number;
    days: number;
    route: string;
    validatedBy: string;
    validatedOn: string;
  },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await requireDrug(tx, drugCode);
    await tx.query(
      `insert into catalog.dosage_templates (drug_code, dose, per_day, days, route, validated_by, validated_on)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        drugCode,
        input.dose,
        input.perDay,
        input.days,
        input.route,
        input.validatedBy,
        input.validatedOn,
      ],
    );
    await writeAudit(tx, ctx, {
      action: "catalog.dosage",
      entityType: "drug",
      entityId: drugCode,
      detail: input,
    });
  });
}

export async function saveInteraction(
  db: Db,
  ctx: RequestContext,
  input: {
    classA: string;
    classB: string;
    messageFr: string;
    messageAr: string;
    validatedBy: string;
    validatedOn: string;
  },
): Promise<void> {
  const [a, b] = [input.classA, input.classB].sort() as [string, string];
  if (a === b)
    throw new DomainError("invalid_interaction", "Deux classes différentes sont nécessaires.", 400);
  await withTransaction(db, async (tx) => {
    await tx.query(
      `insert into catalog.interactions (class_a, class_b, message_fr, message_ar, validated_by, validated_on)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (class_a, class_b) do update set message_fr = excluded.message_fr, message_ar = excluded.message_ar,
         validated_by = excluded.validated_by, validated_on = excluded.validated_on`,
      [a, b, input.messageFr, input.messageAr, input.validatedBy, input.validatedOn],
    );
    await writeAudit(tx, ctx, {
      action: "catalog.interaction",
      entityType: "interaction",
      entityId: `${a}+${b}`,
      detail: input,
    });
  });
}

export interface Interaction {
  classA: string;
  classB: string;
  messageFr: string;
  messageAr: string;
}

export async function interactionsAmong(
  tx: Tx | Db,
  classes: readonly string[],
): Promise<Interaction[]> {
  if (classes.length < 2) return [];
  const res = await tx.query<{
    class_a: string;
    class_b: string;
    message_fr: string;
    message_ar: string;
  }>(
    "select class_a, class_b, message_fr, message_ar from catalog.interactions where class_a = any($1::text[]) and class_b = any($1::text[])",
    [[...new Set(classes)]],
  );
  return res.rows.map((r) => ({
    classA: r.class_a,
    classB: r.class_b,
    messageFr: r.message_fr,
    messageAr: r.message_ar,
  }));
}

/* ------------------------------------------------------------------ limites des constantes */

export interface VitalLimit {
  kind: string;
  unit: string;
  hardMin: number;
  hardMax: number;
  warnMin: number;
  warnMax: number;
  validated: boolean;
}

export async function vitalLimits(tx: Tx | Db): Promise<Map<string, VitalLimit>> {
  const res = await tx.query<{
    kind: string;
    unit: string;
    hard_min: string;
    hard_max: string;
    warn_min: string;
    warn_max: string;
    validated_by: string | null;
  }>(
    "select kind, unit, hard_min, hard_max, warn_min, warn_max, validated_by from catalog.vital_limits",
  );
  return new Map(
    res.rows.map((r) => [
      r.kind,
      {
        kind: r.kind,
        unit: r.unit,
        hardMin: Number(r.hard_min),
        hardMax: Number(r.hard_max),
        warnMin: Number(r.warn_min),
        warnMax: Number(r.warn_max),
        validated: r.validated_by !== null,
      },
    ]),
  );
}

/* ------------------------------------------------------------------ imports CSV */

const DIAG_HEADER = ["code", "libelle_fr", "libelle_ar"];
const DRUG_HEADER = [
  "code",
  "dci",
  "forme",
  "dosage",
  "libelle_ar",
  "classe_allergie",
  "classe_interaction",
  "responsable",
  "date_maj",
];

const isoDate = (value: string): boolean => {
  const d = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value
  );
};

function rowsOf(csv: string, header: string[]): string[][] {
  const rows = parseCsv(csv);
  const got = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  if (got.join(",") !== header.join(",")) {
    throw new DomainError("invalid_header", `En-tête attendu : ${header.join(",")}`, 400, {
      received: got,
    });
  }
  return rows.slice(1);
}

export async function importDiagnoses(
  db: Db,
  ctx: RequestContext,
  csv: string,
): Promise<ImportReport> {
  const rows = rowsOf(csv, DIAG_HEADER);
  return withTransaction(db, async (tx) => {
    const report: ImportReport = {
      applied: true,
      total: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: [],
    };
    const seen = new Set<string>();
    for (const [index, cells] of rows.entries()) {
      const [code, fr, ar] = cells.map((c) => c.trim());
      const errors: string[] = [];
      if (!code) errors.push("code manquant");
      if (code && seen.has(code)) errors.push(`code en double dans le fichier : ${code}`);
      if (!fr) errors.push("libellé français manquant");
      if (!ar) errors.push("libellé arabe manquant");
      if (errors.length > 0) {
        report.rejected.push({ line: index + 2, code: code ?? "", errors });
        continue;
      }
      seen.add(code as string);
      const res = await tx.query<{ inserted: boolean; changed: boolean }>(
        `insert into catalog.diagnoses (code, label_fr, label_ar) values ($1, $2, $3)
         on conflict (code) do update set label_fr = excluded.label_fr, label_ar = excluded.label_ar, active = true
           where (catalog.diagnoses.label_fr, catalog.diagnoses.label_ar) is distinct from (excluded.label_fr, excluded.label_ar)
         returning (xmax = 0) as inserted, true as changed`,
        [code, fr, ar],
      );
      if (!res.rows[0]) report.unchanged += 1;
      else if (res.rows[0].inserted) report.created += 1;
      else report.updated += 1;
    }
    await writeAudit(tx, ctx, {
      action: "catalog.import-diagnoses",
      entityType: "catalog",
      detail: {
        total: report.total,
        created: report.created,
        updated: report.updated,
        rejected: report.rejected.length,
      },
    });
    return report;
  });
}

export async function importDrugs(db: Db, ctx: RequestContext, csv: string): Promise<ImportReport> {
  const rows = rowsOf(csv, DRUG_HEADER);
  return withTransaction(db, async (tx) => {
    const report: ImportReport = {
      applied: true,
      total: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: [],
    };
    const seen = new Set<string>();
    const products = new Set<string>();
    for (const [index, cells] of rows.entries()) {
      const [
        code,
        dci,
        form,
        strength,
        ar,
        allergyClass,
        interactionClass,
        responsible,
        updatedOn,
      ] = cells.map((c) => c.trim());
      const errors: string[] = [];
      if (!code) errors.push("code manquant");
      if (code && seen.has(code)) errors.push(`code en double dans le fichier : ${code}`);
      if (!dci)
        errors.push(
          "DCI manquante (le médicament se saisit en dénomination commune internationale)",
        );
      if (!form) errors.push("forme manquante");
      if (!strength) errors.push("dosage manquant");
      const product = `${(dci ?? "").toLowerCase()}|${(form ?? "").toLowerCase()}|${(strength ?? "").toLowerCase()}`;
      if (dci && products.has(product))
        errors.push("même produit déjà présent dans le fichier (une seule fiche par produit)");
      if (!responsible) errors.push("responsable manquant");
      if (!updatedOn || !isoDate(updatedOn))
        errors.push("date de mise à jour invalide (AAAA-MM-JJ)");
      if (errors.length > 0) {
        report.rejected.push({ line: index + 2, code: code ?? "", errors });
        continue;
      }
      seen.add(code as string);
      products.add(product);
      try {
        await tx.query("savepoint one");
        const res = await tx.query<{ inserted: boolean }>(
          `insert into catalog.drugs (code, dci, form, strength, label_ar, allergy_class, interaction_class, responsible, updated_on)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (code) do update set dci = excluded.dci, form = excluded.form, strength = excluded.strength,
             label_ar = excluded.label_ar, allergy_class = excluded.allergy_class,
             interaction_class = excluded.interaction_class, responsible = excluded.responsible,
             updated_on = excluded.updated_on, active = true
             where (catalog.drugs.dci, catalog.drugs.form, catalog.drugs.strength, catalog.drugs.label_ar,
                    catalog.drugs.allergy_class, catalog.drugs.interaction_class, catalog.drugs.responsible, catalog.drugs.updated_on)
               is distinct from (excluded.dci, excluded.form, excluded.strength, excluded.label_ar,
                                 excluded.allergy_class, excluded.interaction_class, excluded.responsible, excluded.updated_on)
           returning (xmax = 0) as inserted`,
          [
            code,
            dci,
            form,
            strength,
            ar || null,
            allergyClass || null,
            interactionClass || null,
            responsible,
            updatedOn,
          ],
        );
        if (!res.rows[0]) report.unchanged += 1;
        else if (res.rows[0].inserted) report.created += 1;
        else report.updated += 1;
      } catch (error) {
        await tx.query("rollback to savepoint one");
        if ((error as { code?: string }).code === "23505") {
          report.rejected.push({
            line: index + 2,
            code: code ?? "",
            errors: ["ce produit (DCI, forme, dosage) existe déjà sous un autre code"],
          });
        } else throw error;
      }
    }
    await writeAudit(tx, ctx, {
      action: "catalog.import-drugs",
      entityType: "catalog",
      detail: {
        total: report.total,
        created: report.created,
        updated: report.updated,
        rejected: report.rejected.length,
      },
    });
    return report;
  });
}
