import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { interactionsAmong, requireDrug, standardDosages, type Drug } from "../catalog/clinical.ts";
import { activeAllergies, consultationRef } from "../clinical/service.ts";
import { checkDigits } from "../identity/card.ts";
import {
  patientSummaries,
  relatedPatientIds,
  requireActivePatient,
  type PatientSummary,
} from "../identity/interface.ts";
import { renderPrescription } from "./print.ts";

export type Route = "oral" | "injectable" | "cutaneous" | "other";

export interface LineInput {
  drugCode: string;
  dose: number;
  perDay: number;
  days: number;
  route: Route;
}

export interface OverrideInput {
  key: string;
  justification: string;
}

export interface Alert {
  /** Identifiant stable de l'alerte : sert à la justifier. */
  key: string;
  kind: "allergy" | "interaction";
  drugCode: string;
  messageFr: string;
  messageAr: string;
}

export interface PrescriptionLine {
  lineNo: number;
  drugCode: string;
  dci: string;
  form: string;
  strength: string;
  dose: number;
  perDay: number;
  days: number;
  route: Route;
  quantity: number;
  fromStandard: boolean;
}

export interface Prescription {
  id: string;
  number: string;
  patientId: string;
  consultationId: string;
  prescriber: { id: string; name: string | null };
  status: "pending" | "partially_dispensed" | "dispensed" | "superseded" | "cancelled";
  supersedes: string | null;
  renewalOf: string | null;
  revisionReason: string | null;
  signedAt: string;
  /** Pour une ordonnance remplacée : la version en vigueur. */
  currentId?: string;
  lines?: PrescriptionLine[];
  overrides?: {
    key: string;
    kind: string;
    drugCode: string;
    detail: string;
    justification: string;
    justifiedBy: string;
    justifiedAt: string;
  }[];
  patient?: PatientSummary;
}

interface Row {
  id: string;
  number: string;
  patient_id: string;
  consultation_id: string;
  prescriber_id: string;
  prescriber_name: string | null;
  status: Prescription["status"];
  supersedes: string | null;
  renewal_of: string | null;
  revision_reason: string | null;
  signed_at: Date;
}

const COLUMNS =
  "id, number, patient_id, consultation_id, prescriber_id, prescriber_name, status, supersedes, renewal_of, revision_reason, signed_at";

const toPrescription = (r: Row): Prescription => ({
  id: r.id,
  number: r.number,
  patientId: r.patient_id,
  consultationId: r.consultation_id,
  prescriber: { id: r.prescriber_id, name: r.prescriber_name },
  status: r.status,
  supersedes: r.supersedes,
  renewalOf: r.renewal_of,
  revisionReason: r.revision_reason,
  signedAt: r.signed_at.toISOString(),
});

export const lineQuantity = (l: { dose: number; perDay: number; days: number }): number =>
  Math.ceil(l.dose * l.perDay * l.days);

/** Contenu du code de vérification imprimé : le numéro et une clé de contrôle. */
export const prescriptionPayload = (number: string): string =>
  `RX1.${number}.${checkDigits(number)}`;

export function parsePrescriptionPayload(payload: string): string | null {
  const m = /^RX1\.(P-\d{6,})\.(\d{2})$/.exec(payload.trim());
  if (!m || !m[1] || checkDigits(m[1]) !== m[2]) return null;
  return m[1];
}

/* ------------------------------------------------------------------ alertes (F5-3) */

/**
 * Alertes bloquantes : allergie connue du patient, interaction grave listée par le comité médical.
 * Aucune dose n'est calculée ni corrigée automatiquement ; seules ces deux alertes existent, pour éviter la fatigue d'alerte.
 */
export async function checkLines(
  tx: Tx | Db,
  patientId: string,
  lines: LineInput[],
): Promise<{ alerts: Alert[]; drugs: Map<string, Drug> }> {
  const drugs = new Map<string, Drug>();
  for (const l of lines) {
    if (!drugs.has(l.drugCode)) drugs.set(l.drugCode, await requireDrug(tx, l.drugCode));
  }
  if (new Set(lines.map((l) => l.drugCode)).size !== lines.length) {
    throw new DomainError(
      "duplicate_drug",
      "Le même médicament figure deux fois sur l'ordonnance.",
      400,
    );
  }
  const alerts: Alert[] = [];
  const allergies = await activeAllergies(tx, patientId);
  for (const l of lines) {
    const drug = drugs.get(l.drugCode) as Drug;
    const hit = drug.allergyClass
      ? allergies.find((a) => a.substanceClass === drug.allergyClass)
      : undefined;
    if (hit) {
      alerts.push({
        key: `allergy:${drug.code}`,
        kind: "allergy",
        drugCode: drug.code,
        messageFr: `Allergie connue : ${hit.label} (${drug.dci}).`,
        messageAr: `حساسية معروفة : ${hit.label} (${drug.dci}).`,
      });
    }
  }
  const classes = [...drugs.values()]
    .map((d) => d.interactionClass)
    .filter((c): c is string => Boolean(c));
  for (const i of await interactionsAmong(tx, classes)) {
    const involved = [...drugs.values()].filter(
      (d) => d.interactionClass === i.classA || d.interactionClass === i.classB,
    );
    alerts.push({
      key: `interaction:${i.classA}+${i.classB}`,
      kind: "interaction",
      drugCode: involved.map((d) => d.code).join("+"),
      messageFr: i.messageFr,
      messageAr: i.messageAr,
    });
  }
  return { alerts, drugs };
}

/* ------------------------------------------------------------------ création */

async function insertPrescription(
  tx: Tx,
  ctx: RequestContext,
  input: {
    patientId: string;
    consultationId: string;
    lines: LineInput[];
    overrides: OverrideInput[];
    supersedes?: string;
    renewalOf?: string;
    revisionReason?: string;
  },
): Promise<Prescription> {
  const { alerts, drugs } = await checkLines(tx, input.patientId, input.lines);
  const given = new Map(input.overrides.map((o) => [o.key, o.justification]));
  const unknown = input.overrides.filter((o) => !alerts.some((a) => a.key === o.key));
  if (unknown.length > 0) {
    throw new DomainError(
      "unknown_override",
      "Une justification porte sur une alerte qui n'existe pas.",
      400,
      { keys: unknown.map((u) => u.key) },
    );
  }
  const open = alerts.filter((a) => !given.has(a.key));
  if (open.length > 0) {
    throw new DomainError(
      "alerts_require_justification",
      "Alerte bloquante : justifiez par écrit chaque alerte pour continuer, ou changez de médicament.",
      409,
      { alerts: open },
    );
  }
  const number = await nextNumber(tx, "prescriptions", "prescription", "P");
  const res = await tx.query<Row>(
    `insert into prescriptions.prescriptions
       (number, patient_id, consultation_id, prescriber_id, prescriber_name, supersedes, renewal_of, revision_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
    [
      number,
      input.patientId,
      input.consultationId,
      ctx.user.id,
      ctx.user.name,
      input.supersedes ?? null,
      input.renewalOf ?? null,
      input.revisionReason ?? null,
    ],
  );
  const prescription = toPrescription(res.rows[0] as Row);
  const lines: PrescriptionLine[] = [];
  for (const [index, l] of input.lines.entries()) {
    const drug = drugs.get(l.drugCode) as Drug;
    const standard = (await standardDosages(tx, drug.code)).some(
      (s) => s.dose === l.dose && s.perDay === l.perDay && s.days === l.days && s.route === l.route,
    );
    const line: PrescriptionLine = {
      lineNo: index + 1,
      drugCode: drug.code,
      dci: drug.dci,
      form: drug.form,
      strength: drug.strength,
      dose: l.dose,
      perDay: l.perDay,
      days: l.days,
      route: l.route,
      quantity: lineQuantity(l),
      fromStandard: standard,
    };
    lines.push(line);
    await tx.query(
      `insert into prescriptions.lines
         (prescription_id, line_no, drug_code, dci, form, strength, dose, per_day, days, route, quantity, from_standard)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        prescription.id,
        line.lineNo,
        line.drugCode,
        line.dci,
        line.form,
        line.strength,
        line.dose,
        line.perDay,
        line.days,
        line.route,
        line.quantity,
        line.fromStandard,
      ],
    );
  }
  prescription.lines = lines;
  for (const a of alerts) {
    const justification = given.get(a.key) as string;
    await tx.query(
      `insert into prescriptions.overrides (prescription_id, kind, drug_code, detail, justification, justified_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [prescription.id, a.kind, a.drugCode, a.key, justification, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "prescription.override",
      entityType: "prescription",
      entityId: prescription.id,
      patientId: input.patientId,
      detail: { number, alert: a.key, kind: a.kind, justification },
    });
  }
  await writeAudit(tx, ctx, {
    action: "prescription.sign",
    entityType: "prescription",
    entityId: prescription.id,
    patientId: input.patientId,
    detail: {
      number,
      lines: lines.length,
      supersedes: input.supersedes ?? null,
      renewalOf: input.renewalOf ?? null,
    },
  });
  await appendEvent(tx, ctx, {
    type: "PrescriptionCreated",
    patientId: input.patientId,
    payload: {
      prescriptionId: prescription.id,
      number,
      consultationId: input.consultationId,
      supersedes: input.supersedes ?? null,
      lineCount: lines.length,
      hadOverrides: alerts.length > 0,
      prescribedBy: { userId: ctx.user.id, name: ctx.user.name },
    },
  });
  return prescription;
}

/** Vérifie la consultation : ouverte, du prescripteur, et du bon patient. */
async function requireOwnDraftConsultation(
  tx: Tx,
  ctx: RequestContext,
  patientId: string,
  consultationId: string,
) {
  const c = await consultationRef(tx, consultationId);
  const family = await relatedPatientIds(tx, patientId);
  if (!family.includes(c.patientId))
    throw new DomainError(
      "consultation_mismatch",
      "Cette consultation n'appartient pas à ce patient.",
      400,
    );
  if (c.status !== "draft")
    throw new DomainError(
      "consultation_closed",
      "La consultation est clôturée : créez une révision de l'ordonnance.",
      409,
    );
  if (c.practitionerId !== ctx.user.id)
    throw new DomainError(
      "not_your_consultation",
      "Cette consultation est celle d'un autre praticien.",
      403,
    );
  return c;
}

export async function previewAlerts(
  db: Db,
  input: { patientId: string; lines: LineInput[] },
): Promise<Alert[]> {
  const patient = await requireActivePatient(db, input.patientId);
  return (await checkLines(db, patient.id, input.lines)).alerts;
}

export async function createPrescription(
  db: Db,
  ctx: RequestContext,
  input: {
    patientId: string;
    consultationId: string;
    lines: LineInput[];
    overrides: OverrideInput[];
  },
): Promise<Prescription> {
  return withTransaction(db, async (tx) => {
    const patient = await requireActivePatient(tx, input.patientId);
    await requireOwnDraftConsultation(tx, ctx, patient.id, input.consultationId);
    return insertPrescription(tx, ctx, { ...input, patientId: patient.id });
  });
}

/* ------------------------------------------------------------------ lecture */

async function linesOf(tx: Tx | Db, id: string): Promise<PrescriptionLine[]> {
  const res = await tx.query<{
    line_no: number;
    drug_code: string;
    dci: string;
    form: string;
    strength: string;
    dose: string;
    per_day: number;
    days: number;
    route: Route;
    quantity: number;
    from_standard: boolean;
  }>(
    `select line_no, drug_code, dci, form, strength, dose, per_day, days, route, quantity, from_standard
       from prescriptions.lines where prescription_id = $1 order by line_no`,
    [id],
  );
  return res.rows.map((r) => ({
    lineNo: r.line_no,
    drugCode: r.drug_code,
    dci: r.dci,
    form: r.form,
    strength: r.strength,
    dose: Number(r.dose),
    perDay: r.per_day,
    days: r.days,
    route: r.route,
    quantity: r.quantity,
    fromStandard: r.from_standard,
  }));
}

async function currentVersion(tx: Tx | Db, id: string): Promise<string> {
  let current = id;
  for (let i = 0; i < 20; i += 1) {
    const next = await tx.query<{ id: string }>(
      "select id from prescriptions.prescriptions where supersedes = $1",
      [current],
    );
    if (!next.rows[0]) return current;
    current = next.rows[0].id;
  }
  return current;
}

export async function getPrescription(
  db: Db,
  ctx: RequestContext,
  id: string,
): Promise<Prescription> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<Row>(
      `select ${COLUMNS} from prescriptions.prescriptions where id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw notFound("Ordonnance");
    const p = toPrescription(row);
    p.lines = await linesOf(tx, id);
    const ov = await tx.query<{
      detail: string;
      kind: string;
      drug_code: string;
      justification: string;
      justified_by: string;
      justified_at: Date;
    }>(
      "select detail, kind, drug_code, justification, justified_by, justified_at from prescriptions.overrides where prescription_id = $1 order by id",
      [id],
    );
    p.overrides = ov.rows.map((o) => ({
      key: o.detail,
      kind: o.kind,
      drugCode: o.drug_code,
      detail: o.detail,
      justification: o.justification,
      justifiedBy: o.justified_by,
      justifiedAt: o.justified_at.toISOString(),
    }));
    if (p.status === "superseded") p.currentId = await currentVersion(tx, id);
    const person = (await patientSummaries(tx, [p.patientId])).get(p.patientId);
    if (person) p.patient = person;
    await writeAudit(tx, ctx, {
      action: "prescription.read",
      entityType: "prescription",
      entityId: id,
      patientId: p.patientId,
    });
    return p;
  });
}

export async function listPrescriptions(
  db: Db,
  filter: { status?: string | undefined; patientId?: string | undefined },
) {
  const ids = filter.patientId ? await relatedPatientIds(db, filter.patientId) : null;
  const res = await db.query<Row & { line_count: string }>(
    `select ${COLUMNS}, (select count(*) from prescriptions.lines l where l.prescription_id = p.id) as line_count
       from prescriptions.prescriptions p
      where ($1::text is null or status = $1) and ($2::uuid[] is null or patient_id = any($2))
      order by signed_at, number limit 200`,
    [filter.status ?? null, ids],
  );
  const list = res.rows.map((r) => ({ ...toPrescription(r), lineCount: Number(r.line_count) }));
  const people = await patientSummaries(
    db,
    list.map((p) => p.patientId),
  );
  return list.map((p) => ({ ...p, patient: people.get(p.patientId) ?? null }));
}

/** Pour l'historique du dossier. */
export async function prescriptionSummaries(tx: Tx | Db, patientIds: string[]) {
  const res = await tx.query<{
    id: string;
    number: string;
    status: string;
    signed_at: Date;
    supersedes: string | null;
    lines: string[] | null;
  }>(
    `select p.id, p.number, p.status, p.signed_at, p.supersedes,
            (select array_agg(l.dci || ' ' || l.strength order by l.line_no) from prescriptions.lines l where l.prescription_id = p.id) as lines
       from prescriptions.prescriptions p where p.patient_id = any($1::uuid[]) order by p.signed_at desc limit 200`,
    [patientIds],
  );
  return res.rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    signedAt: r.signed_at.toISOString(),
    supersedes: r.supersedes,
    lines: r.lines ?? [],
  }));
}

/* ------------------------------------------------------------------ révision et renouvellement (F5-6) */

/** La nouvelle version remplace l'ancienne, qui reste consultable. Impossible si la pharmacie a commencé à servir. */
export async function revisePrescription(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { lines: LineInput[]; overrides: OverrideInput[]; reason: string },
): Promise<{ previous: Prescription; prescription: Prescription }> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<Row>(
      `select ${COLUMNS} from prescriptions.prescriptions where id = $1 for update`,
      [id],
    );
    const old = found.rows[0];
    if (!old) throw notFound("Ordonnance");
    if (old.prescriber_id !== ctx.user.id) {
      throw new DomainError(
        "not_your_prescription",
        "Seul le prescripteur peut réviser son ordonnance.",
        403,
      );
    }
    if (old.status === "partially_dispensed" || old.status === "dispensed") {
      throw new DomainError(
        "already_dispensed",
        "La pharmacie a déjà servi cette ordonnance : elle ne se révise plus.",
        409,
      );
    }
    if (old.status !== "pending")
      throw new DomainError("not_revisable", "Cette ordonnance n'est plus en vigueur.", 409);
    const patient = await requireActivePatient(tx, old.patient_id).catch(() => null);
    const patientId = patient?.id ?? old.patient_id;
    const prescription = await insertPrescription(tx, ctx, {
      patientId,
      consultationId: old.consultation_id,
      lines: input.lines,
      overrides: input.overrides,
      supersedes: id,
      revisionReason: input.reason,
    });
    await tx.query("update prescriptions.prescriptions set status = 'superseded' where id = $1", [
      id,
    ]);
    const previous = toPrescription({ ...old, status: "superseded" });
    return { previous, prescription };
  });
}

/** Renouvellement : copie d'une ancienne ordonnance dans une consultation ouverte, avec les contrôles d'aujourd'hui. */
export async function renewPrescription(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { consultationId: string; overrides: OverrideInput[] },
): Promise<Prescription> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<Row>(
      `select ${COLUMNS} from prescriptions.prescriptions where id = $1`,
      [id],
    );
    const old = found.rows[0];
    if (!old) throw notFound("Ordonnance");
    if (old.status === "cancelled")
      throw new DomainError("not_renewable", "Cette ordonnance a été annulée.", 409);
    const patient = await requireActivePatient(tx, old.patient_id).catch(async () => {
      const family = await relatedPatientIds(tx, old.patient_id);
      return requireActivePatient(tx, family[0] as string);
    });
    await requireOwnDraftConsultation(tx, ctx, patient.id, input.consultationId);
    const lines = (await linesOf(tx, id)).map((l) => ({
      drugCode: l.drugCode,
      dose: l.dose,
      perDay: l.perDay,
      days: l.days,
      route: l.route,
    }));
    return insertPrescription(tx, ctx, {
      patientId: patient.id,
      consultationId: input.consultationId,
      lines,
      overrides: input.overrides,
      renewalOf: id,
    });
  });
}

/* ------------------------------------------------------------------ impression et vérification (F5-4) */

export async function printPrescription(db: Db, ctx: RequestContext, id: string) {
  const p = await getPrescription(db, ctx, id);
  if (p.status === "cancelled")
    throw new DomainError("cancelled", "Cette ordonnance est annulée.", 409);
  const payload = prescriptionPayload(p.number);
  const html = renderPrescription({ prescription: p, payload });
  return { number: p.number, payload, status: p.status, html };
}

/** Scan du QR de l'ordonnance papier : renvoie l'ordonnance en vigueur, même si le papier est d'une ancienne version. */
export async function verifyPrescription(db: Db, ctx: RequestContext, payload: string) {
  const number = parsePrescriptionPayload(payload);
  if (!number)
    throw new DomainError("invalid_code", "Code de vérification illisible ou invalide.", 400);
  const found = await db.query<{ id: string }>(
    "select id from prescriptions.prescriptions where number = $1",
    [number],
  );
  if (!found.rows[0]) throw notFound("Ordonnance");
  const scanned = await getPrescription(db, ctx, found.rows[0].id);
  const currentId =
    scanned.status === "superseded" ? await currentVersion(db, scanned.id) : scanned.id;
  return {
    scannedNumber: scanned.number,
    scannedStatus: scanned.status,
    superseded: scanned.status === "superseded",
    currentId,
    valid: scanned.status === "pending" || scanned.status === "partially_dispensed",
  };
}
