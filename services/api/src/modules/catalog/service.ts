import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { parseCsv } from "../../common/csv.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";

export type ActCategory = "consultation" | "laboratory" | "imaging" | "hospitalization" | "other";

export interface Act {
  code: string;
  labelFr: string;
  labelAr: string;
  tariff: number;
  departmentCode: string;
  category: ActCategory;
  active: boolean;
}

export interface Payer {
  code: string;
  nameFr: string;
  nameAr: string;
  patientShare: number;
  active: boolean;
}

export interface Department {
  code: string;
  nameFr: string;
  nameAr: string;
  active: boolean;
}

interface ActRow {
  code: string;
  label_fr: string;
  label_ar: string;
  tariff: number;
  department_code: string;
  category: ActCategory;
  active: boolean;
}

const toAct = (r: ActRow): Act => ({
  code: r.code,
  labelFr: r.label_fr,
  labelAr: r.label_ar,
  tariff: r.tariff,
  departmentCode: r.department_code,
  category: r.category,
  active: r.active,
});

/* ------------------------------------------------------------------ lectures (interface du module) */

export async function getActs(tx: Tx | Db, codes: readonly string[]): Promise<Map<string, Act>> {
  const res = await tx.query<ActRow>(
    `select code, label_fr, label_ar, tariff, department_code, category, active
       from catalog.acts where code = any($1::text[])`,
    [[...new Set(codes)]],
  );
  return new Map(res.rows.map((r) => [r.code, toAct(r)]));
}

export async function requireAct(tx: Tx | Db, code: string): Promise<Act> {
  const act = (await getActs(tx, [code])).get(code);
  if (!act) throw notFound(`Acte ${code}`);
  if (!act.active) throw new DomainError("act_inactive", `L'acte ${code} n'est plus proposé.`, 409);
  return act;
}

export async function requirePayer(tx: Tx | Db, code: string): Promise<Payer> {
  const res = await tx.query<{
    code: string;
    name_fr: string;
    name_ar: string;
    patient_share: string;
    active: boolean;
  }>("select code, name_fr, name_ar, patient_share, active from catalog.payers where code = $1", [
    code,
  ]);
  const r = res.rows[0];
  if (!r) throw notFound(`Payeur ${code}`);
  if (!r.active)
    throw new DomainError("payer_inactive", `Le payeur ${code} n'est plus proposé.`, 409);
  return {
    code: r.code,
    nameFr: r.name_fr,
    nameAr: r.name_ar,
    patientShare: Number(r.patient_share),
    active: r.active,
  };
}

export async function requireDepartment(tx: Tx | Db, code: string): Promise<Department> {
  const res = await tx.query<{ code: string; name_fr: string; name_ar: string; active: boolean }>(
    "select code, name_fr, name_ar, active from catalog.departments where code = $1",
    [code],
  );
  const r = res.rows[0];
  if (!r) throw notFound(`Service ${code}`);
  if (!r.active) throw new DomainError("department_inactive", `Le service ${code} est fermé.`, 409);
  return { code: r.code, nameFr: r.name_fr, nameAr: r.name_ar, active: r.active };
}

export async function listDepartments(db: Db): Promise<Department[]> {
  const res = await db.query<{ code: string; name_fr: string; name_ar: string; active: boolean }>(
    "select code, name_fr, name_ar, active from catalog.departments order by code",
  );
  return res.rows.map((r) => ({
    code: r.code,
    nameFr: r.name_fr,
    nameAr: r.name_ar,
    active: r.active,
  }));
}

export async function listPayers(db: Db): Promise<Payer[]> {
  const res = await db.query<{
    code: string;
    name_fr: string;
    name_ar: string;
    patient_share: string;
    active: boolean;
  }>("select code, name_fr, name_ar, patient_share, active from catalog.payers order by code");
  return res.rows.map((r) => ({
    code: r.code,
    nameFr: r.name_fr,
    nameAr: r.name_ar,
    patientShare: Number(r.patient_share),
    active: r.active,
  }));
}

export async function listActs(
  db: Db,
  filter: { department?: string; category?: string } = {},
): Promise<Act[]> {
  const res = await db.query<ActRow>(
    `select code, label_fr, label_ar, tariff, department_code, category, active
       from catalog.acts
      where ($1::text is null or department_code = $1) and ($2::text is null or category = $2)
      order by code`,
    [filter.department ?? null, filter.category ?? null],
  );
  return res.rows.map(toAct);
}

/* ------------------------------------------------------------------ import CSV (F2-2) */

export interface RejectedLine {
  line: number;
  code: string;
  errors: string[];
}

export interface ImportReport {
  /** Les lignes valides ont-elles été enregistrées ? Faux si le mode strict a tout refusé. */
  applied: boolean;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: RejectedLine[];
}

const ACT_HEADER = [
  "code",
  "libelle_fr",
  "libelle_ar",
  "tarif_fdj",
  "service",
  "categorie",
  "responsable",
  "date_maj",
];
const PAYER_HEADER = [
  "code",
  "libelle_fr",
  "libelle_ar",
  "part_patient",
  "responsable",
  "date_maj",
];

const CATEGORY_BY_LABEL: Record<string, ActCategory> = {
  consultation: "consultation",
  laboratoire: "laboratory",
  imagerie: "imaging",
  hospitalisation: "hospitalization",
  autre: "other",
};

const isoDate = (value: string): boolean => {
  const d = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value
  );
};

function checkHeader(rows: string[][], expected: readonly string[]): string[][] {
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  if (header.join(",") !== expected.join(",")) {
    throw new DomainError("invalid_header", `En-tête attendu : ${expected.join(",")}`, 400, {
      received: header,
    });
  }
  return rows.slice(1);
}

interface ParsedAct {
  code: string;
  labelFr: string;
  labelAr: string;
  tariff: number;
  departmentCode: string;
  category: ActCategory;
  responsible: string;
  updatedOn: string;
}

function parseActRow(
  cells: string[],
  departments: Set<string>,
): { value?: ParsedAct; errors: string[] } {
  const [code, labelFr, labelAr, tariff, department, category, responsible, updatedOn] = cells.map(
    (c) => c.trim(),
  );
  const errors: string[] = [];
  if (!code) errors.push("code manquant");
  if (!labelFr) errors.push("libellé français manquant");
  if (!labelAr) errors.push("libellé arabe manquant");
  const price = Number(tariff);
  if (!tariff || !/^\d+$/.test(tariff) || !Number.isSafeInteger(price)) {
    errors.push("tarif : entier positif attendu (francs Djibouti)");
  }
  if (!department || !departments.has(department))
    errors.push(`service inconnu : ${department ?? ""}`);
  const cat = category ? CATEGORY_BY_LABEL[category.toLowerCase()] : undefined;
  if (!cat) errors.push(`catégorie inconnue : ${category ?? ""}`);
  if (!responsible) errors.push("responsable manquant");
  if (!updatedOn || !isoDate(updatedOn)) errors.push("date de mise à jour invalide (AAAA-MM-JJ)");
  if (errors.length > 0) return { errors };
  return {
    errors,
    value: {
      code: code as string,
      labelFr: labelFr as string,
      labelAr: labelAr as string,
      tariff: price,
      departmentCode: department as string,
      category: cat as ActCategory,
      responsible: responsible as string,
      updatedOn: updatedOn as string,
    },
  };
}

/**
 * Importe le catalogue des actes et tarifs. Une ligne invalide n'est jamais importée et figure dans le
 * rapport avec ses erreurs. En mode strict, la moindre erreur annule tout l'import.
 */
export async function importActs(
  db: Db,
  ctx: RequestContext,
  csv: string,
  options: { strict?: boolean } = {},
): Promise<ImportReport> {
  const rows = checkHeader(parseCsv(csv), ACT_HEADER);
  return withTransaction(db, async (tx) => {
    const deps = await tx.query<{ code: string }>(
      "select code from catalog.departments where active",
    );
    const departments = new Set(deps.rows.map((d) => d.code));
    const report: ImportReport = {
      applied: true,
      total: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: [],
    };
    const valid: ParsedAct[] = [];
    const seen = new Set<string>();
    rows.forEach((cells, index) => {
      const line = index + 2; // ligne 1 = en-tête
      const { value, errors } = parseActRow(cells, departments);
      const code = (cells[0] ?? "").trim();
      if (value && seen.has(value.code))
        errors.push(`code en double dans le fichier : ${value.code}`);
      if (errors.length > 0 || !value) {
        report.rejected.push({ line, code, errors });
        return;
      }
      seen.add(value.code);
      valid.push(value);
    });
    if (options.strict && report.rejected.length > 0) {
      report.applied = false;
      return report;
    }
    for (const a of valid) {
      const before = await tx.query<ActRow & { responsible: string; updated_on: string }>(
        `select code, label_fr, label_ar, tariff, department_code, category, active, responsible,
                updated_on::text as updated_on from catalog.acts where code = $1 for update`,
        [a.code],
      );
      const old = before.rows[0];
      const after = {
        label_fr: a.labelFr,
        label_ar: a.labelAr,
        tariff: a.tariff,
        department_code: a.departmentCode,
        category: a.category,
        responsible: a.responsible,
        updated_on: a.updatedOn,
      };
      if (!old) {
        await tx.query(
          `insert into catalog.acts (code, label_fr, label_ar, tariff, department_code, category, responsible, updated_on)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            a.code,
            a.labelFr,
            a.labelAr,
            a.tariff,
            a.departmentCode,
            a.category,
            a.responsible,
            a.updatedOn,
          ],
        );
        report.created += 1;
      } else {
        const same =
          old.label_fr === a.labelFr &&
          old.label_ar === a.labelAr &&
          old.tariff === a.tariff &&
          old.department_code === a.departmentCode &&
          old.category === a.category &&
          old.responsible === a.responsible &&
          old.updated_on === a.updatedOn;
        if (same) {
          report.unchanged += 1;
          continue;
        }
        await tx.query(
          `update catalog.acts set label_fr = $2, label_ar = $3, tariff = $4, department_code = $5, category = $6,
                  responsible = $7, updated_on = $8, active = true where code = $1`,
          [
            a.code,
            a.labelFr,
            a.labelAr,
            a.tariff,
            a.departmentCode,
            a.category,
            a.responsible,
            a.updatedOn,
          ],
        );
        report.updated += 1;
      }
      await tx.query(
        "insert into catalog.history (changed_by, catalog, code, before, after) values ($1, 'acts', $2, $3, $4)",
        [ctx.user.id, a.code, old ? JSON.stringify(old) : null, JSON.stringify(after)],
      );
    }
    await writeAudit(tx, ctx, {
      action: "catalog.import-acts",
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

/** Importe les payeurs et leur part patient (0 = gratuité, 1 = paiement direct). */
export async function importPayers(
  db: Db,
  ctx: RequestContext,
  csv: string,
  options: { strict?: boolean } = {},
): Promise<ImportReport> {
  const rows = checkHeader(parseCsv(csv), PAYER_HEADER);
  return withTransaction(db, async (tx) => {
    const report: ImportReport = {
      applied: true,
      total: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: [],
    };
    const valid: {
      code: string;
      nameFr: string;
      nameAr: string;
      share: number;
      responsible: string;
      updatedOn: string;
    }[] = [];
    const seen = new Set<string>();
    rows.forEach((cells, index) => {
      const line = index + 2;
      const [code, nameFr, nameAr, shareText, responsible, updatedOn] = cells.map((c) => c.trim());
      const errors: string[] = [];
      if (!code) errors.push("code manquant");
      if (code && seen.has(code)) errors.push(`code en double dans le fichier : ${code}`);
      if (!nameFr) errors.push("libellé français manquant");
      if (!nameAr) errors.push("libellé arabe manquant");
      let share = Number.NaN;
      if (shareText) {
        share = shareText.endsWith("%")
          ? Number(shareText.slice(0, -1).replace(",", ".")) / 100
          : Number(shareText.replace(",", "."));
      }
      if (Number.isNaN(share) || share < 0 || share > 1)
        errors.push("part patient : nombre de 0 à 1 attendu");
      if (!responsible) errors.push("responsable manquant");
      if (!updatedOn || !isoDate(updatedOn))
        errors.push("date de mise à jour invalide (AAAA-MM-JJ)");
      if (errors.length > 0) {
        report.rejected.push({ line, code: code ?? "", errors });
        return;
      }
      seen.add(code as string);
      valid.push({
        code: code as string,
        nameFr: nameFr as string,
        nameAr: nameAr as string,
        share: Math.round(share * 1000) / 1000,
        responsible: responsible as string,
        updatedOn: updatedOn as string,
      });
    });
    if (options.strict && report.rejected.length > 0) {
      report.applied = false;
      return report;
    }
    for (const p of valid) {
      const before = await tx.query<{
        name_fr: string;
        name_ar: string;
        patient_share: string;
        responsible: string;
        updated_on: string;
      }>(
        "select name_fr, name_ar, patient_share, responsible, updated_on::text as updated_on from catalog.payers where code = $1 for update",
        [p.code],
      );
      const old = before.rows[0];
      if (!old) {
        await tx.query(
          `insert into catalog.payers (code, name_fr, name_ar, patient_share, responsible, updated_on)
           values ($1, $2, $3, $4, $5, $6)`,
          [p.code, p.nameFr, p.nameAr, p.share, p.responsible, p.updatedOn],
        );
        report.created += 1;
      } else if (
        old.name_fr === p.nameFr &&
        old.name_ar === p.nameAr &&
        Number(old.patient_share) === p.share &&
        old.responsible === p.responsible &&
        old.updated_on === p.updatedOn
      ) {
        report.unchanged += 1;
        continue;
      } else {
        await tx.query(
          `update catalog.payers set name_fr = $2, name_ar = $3, patient_share = $4, responsible = $5,
                  updated_on = $6, active = true where code = $1`,
          [p.code, p.nameFr, p.nameAr, p.share, p.responsible, p.updatedOn],
        );
        report.updated += 1;
      }
      await tx.query(
        "insert into catalog.history (changed_by, catalog, code, before, after) values ($1, 'payers', $2, $3, $4)",
        [
          ctx.user.id,
          p.code,
          old ? JSON.stringify(old) : null,
          JSON.stringify({ patient_share: p.share, name_fr: p.nameFr }),
        ],
      );
    }
    await writeAudit(tx, ctx, {
      action: "catalog.import-payers",
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
