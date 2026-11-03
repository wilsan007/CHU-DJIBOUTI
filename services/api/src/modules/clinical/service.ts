import { createHash } from "node:crypto";
import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { can } from "../../auth/permissions.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { SIGNATURES } from "../../common/files.ts";
import { appendEvent } from "../../events/outbox.ts";
import { getEncounter } from "../billing/service.ts";
import { requireDiagnosis, vitalLimits } from "../catalog/clinical.ts";
import {
  relatedPatientIds,
  requireActivePatient,
  type PatientSummary,
} from "../identity/interface.ts";
import { getPatient } from "../identity/service.ts";
import { renderReport } from "./report.ts";

export const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES ?? 5 * 1024 * 1024);

/* ------------------------------------------------------------------ types */

export interface Vital {
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
  measuredBy: string;
  confirmedUnusual: boolean;
}

export interface DiagnosisEntry {
  code: string;
  labelFr: string;
  labelAr: string;
  primary: boolean;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size: number;
  uploadedAt: string;
}

export interface Consultation {
  id: string;
  patientId: string;
  encounterId: string;
  practitioner: { id: string; name: string | null };
  status: "draft" | "closed";
  reason: string;
  exam: string;
  notes: string;
  templateId: number | null;
  version: number;
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
  vitals?: Vital[];
  diagnoses?: DiagnosisEntry[];
  attachments?: AttachmentMeta[];
}

interface Row {
  id: string;
  patient_id: string;
  encounter_id: string;
  practitioner_id: string;
  practitioner_name: string | null;
  status: "draft" | "closed";
  reason: string;
  exam: string;
  notes: string;
  template_id: string | null;
  version: number;
  opened_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

const COLUMNS = `id, patient_id, encounter_id, practitioner_id, practitioner_name, status, reason, exam, notes,
  template_id, version, opened_at, updated_at, closed_at`;

const toConsultation = (r: Row): Consultation => ({
  id: r.id,
  patientId: r.patient_id,
  encounterId: r.encounter_id,
  practitioner: { id: r.practitioner_id, name: r.practitioner_name },
  status: r.status,
  reason: r.reason,
  exam: r.exam,
  notes: r.notes,
  templateId: r.template_id === null ? null : Number(r.template_id),
  version: r.version,
  openedAt: r.opened_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  closedAt: r.closed_at ? r.closed_at.toISOString() : null,
});

async function lock(tx: Tx, id: string): Promise<Row> {
  const res = await tx.query<Row>(
    `select ${COLUMNS} from clinical.consultations where id = $1 for update`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Consultation");
  return row;
}

function requireOwner(row: Row, ctx: RequestContext): void {
  if (row.practitioner_id !== ctx.user.id) {
    throw new DomainError(
      "not_your_consultation",
      "Cette consultation est celle d'un autre praticien.",
      403,
    );
  }
}

function requireDraft(row: Row): void {
  if (row.status !== "draft") {
    throw new DomainError(
      "consultation_closed",
      "Cette consultation est clôturée : elle ne se modifie plus.",
      409,
    );
  }
}

/* ------------------------------------------------------------------ ouverture */

export async function startConsultation(
  db: Db,
  ctx: RequestContext,
  input: { patientId: string; encounterId: string; templateId?: number | undefined },
): Promise<Consultation> {
  try {
    return await withTransaction(db, async (tx) => {
      const patient = await requireActivePatient(tx, input.patientId);
      const encounter = await getEncounter(tx, input.encounterId);
      const family = await relatedPatientIds(tx, patient.id);
      if (!family.includes(encounter.patientId)) {
        throw new DomainError(
          "encounter_mismatch",
          "Cette admission n'appartient pas à ce patient.",
          400,
        );
      }
      if (encounter.status !== "open")
        throw new DomainError("encounter_closed", "Cette admission est clôturée.", 409);
      let reason = "";
      let exam = "";
      if (input.templateId !== undefined) {
        const t = await tx.query<{ reason_text: string; exam_text: string; active: boolean }>(
          "select reason_text, exam_text, active from clinical.templates where id = $1",
          [input.templateId],
        );
        const tpl = t.rows[0];
        if (!tpl || !tpl.active) throw notFound("Modèle");
        reason = tpl.reason_text;
        exam = tpl.exam_text;
      }
      const res = await tx.query<Row>(
        `insert into clinical.consultations (patient_id, encounter_id, practitioner_id, practitioner_name, reason, exam, template_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
        [
          patient.id,
          encounter.id,
          ctx.user.id,
          ctx.user.name,
          reason,
          exam,
          input.templateId ?? null,
        ],
      );
      const consultation = toConsultation(res.rows[0] as Row);
      await writeAudit(tx, ctx, {
        action: "consultation.start",
        entityType: "consultation",
        entityId: consultation.id,
        patientId: patient.id,
        detail: { encounterId: encounter.id, templateId: input.templateId ?? null },
      });
      return consultation;
    });
  } catch (error) {
    if (
      (error as { code?: string; constraint?: string }).constraint ===
      "consultations_one_draft_per_encounter_idx"
    ) {
      throw new DomainError(
        "consultation_already_open",
        "Une consultation est déjà ouverte pour cette admission.",
        409,
      );
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ lecture */

async function details(tx: Tx | Db, c: Consultation): Promise<Consultation> {
  const vitals = await tx.query<{
    kind: string;
    value: string;
    unit: string;
    measured_at: Date;
    measured_by: string;
    confirmed_unusual: boolean;
  }>(
    "select kind, value, unit, measured_at, measured_by, confirmed_unusual from clinical.vitals where consultation_id = $1 order by id",
    [c.id],
  );
  const diagnoses = await tx.query<{
    code: string;
    label_fr: string;
    label_ar: string;
    is_primary: boolean;
  }>(
    "select code, label_fr, label_ar, is_primary from clinical.consultation_diagnoses where consultation_id = $1 order by is_primary desc, code",
    [c.id],
  );
  const attachments = await tx.query<{
    id: string;
    filename: string;
    mime: string;
    size: number;
    uploaded_at: Date;
  }>(
    "select id, filename, mime, size, uploaded_at from clinical.attachments where consultation_id = $1 order by uploaded_at",
    [c.id],
  );
  return {
    ...c,
    vitals: vitals.rows.map((v) => ({
      kind: v.kind,
      value: Number(v.value),
      unit: v.unit,
      measuredAt: v.measured_at.toISOString(),
      measuredBy: v.measured_by,
      confirmedUnusual: v.confirmed_unusual,
    })),
    diagnoses: diagnoses.rows.map((d) => ({
      code: d.code,
      labelFr: d.label_fr,
      labelAr: d.label_ar,
      primary: d.is_primary,
    })),
    attachments: attachments.rows.map((a) => ({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      uploadedAt: a.uploaded_at.toISOString(),
    })),
  };
}

/** Ouvrir une consultation est tracé : qui a consulté le dossier de quel patient. */
/** Consultation en cours (brouillon) de l'admission, sinon la dernière : le portail l'ouvre à partir de la file d'attente. */
export async function consultationOfEncounter(
  db: Db,
  ctx: RequestContext,
  encounterId: string,
): Promise<Consultation | null> {
  // Admission inconnue : 404. Admission connue sans consultation commencée : état normal, rendu « vide » (pas une erreur).
  await getEncounter(db, encounterId);
  const res = await db.query<{ id: string }>(
    `select id from clinical.consultations where encounter_id = $1
      order by (status = 'draft') desc, opened_at desc limit 1`,
    [encounterId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return getConsultation(db, ctx, row.id);
}

export async function getConsultation(
  db: Db,
  ctx: RequestContext,
  id: string,
): Promise<Consultation> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<Row>(`select ${COLUMNS} from clinical.consultations where id = $1`, [
      id,
    ]);
    const row = res.rows[0];
    if (!row) throw notFound("Consultation");
    await writeAudit(tx, ctx, {
      action: "consultation.read",
      entityType: "consultation",
      entityId: id,
      patientId: row.patient_id,
    });
    return details(tx, toConsultation(row));
  });
}

/* ------------------------------------------------------------------ saisie (brouillon) */

/**
 * Enregistre les textes de la consultation. En cas de modification simultanée (la version a changé),
 * rien n'est écrasé : l'utilisateur reçoit les deux versions et choisit (409 edit_conflict).
 */
export async function saveConsultation(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: {
    expectedVersion: number;
    reason?: string | undefined;
    exam?: string | undefined;
    notes?: string | undefined;
  },
): Promise<Consultation> {
  return withTransaction(db, async (tx) => {
    const row = await lock(tx, id);
    requireOwner(row, ctx);
    requireDraft(row);
    if (row.version !== input.expectedVersion) {
      throw new DomainError(
        "edit_conflict",
        "Ce brouillon a été modifié entre-temps. Comparez les deux versions et choisissez.",
        409,
        {
          current: { reason: row.reason, exam: row.exam, notes: row.notes, version: row.version },
          submitted: { reason: input.reason, exam: input.exam, notes: input.notes },
        },
      );
    }
    const res = await tx.query<Row>(
      `update clinical.consultations
          set reason = coalesce($2, reason), exam = coalesce($3, exam), notes = coalesce($4, notes),
              version = version + 1, updated_at = now()
        where id = $1 returning ${COLUMNS}`,
      [id, input.reason ?? null, input.exam ?? null, input.notes ?? null],
    );
    const updated = toConsultation(res.rows[0] as Row);
    await writeAudit(tx, ctx, {
      action: "consultation.save",
      entityType: "consultation",
      entityId: id,
      patientId: updated.patientId,
      detail: { version: updated.version },
    });
    return updated;
  });
}

/* ------------------------------------------------------------------ constantes (F4-2) */

export async function recordVital(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { kind: string; value: number; confirm?: boolean | undefined },
): Promise<Vital> {
  return withTransaction(db, async (tx) => {
    const row = await lock(tx, id);
    requireDraft(row);
    const limits = (await vitalLimits(tx)).get(input.kind);
    if (!limits) throw new DomainError("unknown_vital", `Constante inconnue : ${input.kind}.`, 400);
    if (input.value < limits.hardMin || input.value > limits.hardMax) {
      throw new DomainError(
        "vital_impossible",
        `Valeur impossible pour cette constante (${limits.hardMin} à ${limits.hardMax} ${limits.unit}).`,
        400,
        { limits },
      );
    }
    const unusual = input.value < limits.warnMin || input.value > limits.warnMax;
    if (unusual && !input.confirm) {
      throw new DomainError(
        "value_needs_confirmation",
        "Valeur inhabituelle : vérifiez la mesure puis confirmez.",
        409,
        { limits, value: input.value },
      );
    }
    const res = await tx.query<{ measured_at: Date }>(
      `insert into clinical.vitals (consultation_id, kind, value, unit, measured_by, confirmed_unusual)
       values ($1, $2, $3, $4, $5, $6) returning measured_at`,
      [id, input.kind, input.value, limits.unit, ctx.user.id, unusual],
    );
    await writeAudit(tx, ctx, {
      action: "consultation.vital",
      entityType: "consultation",
      entityId: id,
      patientId: row.patient_id,
      detail: { kind: input.kind, unusual },
    });
    return {
      kind: input.kind,
      value: input.value,
      unit: limits.unit,
      measuredAt: (res.rows[0] as { measured_at: Date }).measured_at.toISOString(),
      measuredBy: ctx.user.id,
      confirmedUnusual: unusual,
    };
  });
}

/* ------------------------------------------------------------------ diagnostics (F4-3) */

export async function addDiagnosis(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { code: string; primary?: boolean | undefined },
): Promise<DiagnosisEntry[]> {
  return withTransaction(db, async (tx) => {
    const row = await lock(tx, id);
    requireOwner(row, ctx);
    requireDraft(row);
    const d = await requireDiagnosis(tx, input.code);
    const existing = await tx.query<{ n: string }>(
      "select count(*) as n from clinical.consultation_diagnoses where consultation_id = $1",
      [id],
    );
    const first = Number(existing.rows[0]?.n ?? 0) === 0;
    const primary = input.primary ?? first;
    if (primary) {
      await tx.query(
        "delete from clinical.consultation_diagnoses where consultation_id = $1 and code = $2",
        [id, d.code],
      );
    }
    await tx.query(
      `insert into clinical.consultation_diagnoses (consultation_id, code, label_fr, label_ar, is_primary, added_by)
       values ($1, $2, $3, $4, false, $5) on conflict do nothing`,
      [id, d.code, d.labelFr, d.labelAr, ctx.user.id],
    );
    if (primary) {
      // Un seul diagnostic principal : on remplace les lignes (suppression + insertion, autorisées en brouillon).
      const all = await tx.query<{ code: string; label_fr: string; label_ar: string }>(
        "select code, label_fr, label_ar from clinical.consultation_diagnoses where consultation_id = $1",
        [id],
      );
      await tx.query("delete from clinical.consultation_diagnoses where consultation_id = $1", [
        id,
      ]);
      for (const r of all.rows) {
        await tx.query(
          `insert into clinical.consultation_diagnoses (consultation_id, code, label_fr, label_ar, is_primary, added_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [id, r.code, r.label_fr, r.label_ar, r.code === d.code, ctx.user.id],
        );
      }
    }
    await writeAudit(tx, ctx, {
      action: "consultation.diagnosis-add",
      entityType: "consultation",
      entityId: id,
      patientId: row.patient_id,
      detail: { code: d.code, primary },
    });
    return (await details(tx, toConsultation(row))).diagnoses ?? [];
  });
}

export async function removeDiagnosis(
  db: Db,
  ctx: RequestContext,
  id: string,
  code: string,
): Promise<DiagnosisEntry[]> {
  return withTransaction(db, async (tx) => {
    const row = await lock(tx, id);
    requireOwner(row, ctx);
    requireDraft(row);
    const res = await tx.query(
      "delete from clinical.consultation_diagnoses where consultation_id = $1 and code = $2",
      [id, code],
    );
    if (!res.rowCount) throw notFound(`Diagnostic ${code}`);
    await writeAudit(tx, ctx, {
      action: "consultation.diagnosis-remove",
      entityType: "consultation",
      entityId: id,
      patientId: row.patient_id,
      detail: { code },
    });
    return (await details(tx, toConsultation(row))).diagnoses ?? [];
  });
}

/* ------------------------------------------------------------------ pièces jointes (F4-7) */

export async function addAttachment(
  db: Db,
  ctx: RequestContext,
  consultationId: string,
  input: { filename: string; mime: string; dataBase64: string },
): Promise<AttachmentMeta> {
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) throw new DomainError("empty_file", "Fichier vide.", 400);
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new DomainError(
      "attachment_too_large",
      `Fichier trop volumineux (maximum ${Math.floor(MAX_ATTACHMENT_BYTES / 1024)} Ko).`,
      413,
    );
  }
  const check = SIGNATURES[input.mime];
  if (!check)
    throw new DomainError(
      "unsupported_type",
      "Seuls les images PNG ou JPEG et les PDF sont acceptés.",
      415,
    );
  if (!check(data))
    throw new DomainError("mime_mismatch", "Le contenu ne correspond pas au type annoncé.", 400);
  return withTransaction(db, async (tx) => {
    const found = await tx.query<{ patient_id: string }>(
      "select patient_id from clinical.consultations where id = $1",
      [consultationId],
    );
    const consultation = found.rows[0];
    if (!consultation) throw notFound("Consultation");
    const sha = createHash("sha256").update(data).digest("hex");
    const res = await tx.query<{ id: string; uploaded_at: Date }>(
      `insert into clinical.attachments (consultation_id, patient_id, filename, mime, size, sha256, data, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, uploaded_at`,
      [
        consultationId,
        consultation.patient_id,
        input.filename,
        input.mime,
        data.length,
        sha,
        data,
        ctx.user.id,
      ],
    );
    const r = res.rows[0] as { id: string; uploaded_at: Date };
    await writeAudit(tx, ctx, {
      action: "attachment.add",
      entityType: "attachment",
      entityId: r.id,
      patientId: consultation.patient_id,
      detail: { filename: input.filename, size: data.length },
    });
    return {
      id: r.id,
      filename: input.filename,
      mime: input.mime,
      size: data.length,
      uploadedAt: r.uploaded_at.toISOString(),
    };
  });
}

export async function getAttachment(
  db: Db,
  ctx: RequestContext,
  id: string,
): Promise<{ filename: string; mime: string; data: Buffer }> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{
      filename: string;
      mime: string;
      data: Buffer;
      patient_id: string;
    }>("select filename, mime, data, patient_id from clinical.attachments where id = $1", [id]);
    const r = res.rows[0];
    if (!r) throw notFound("Pièce jointe");
    await writeAudit(tx, ctx, {
      action: "attachment.read",
      entityType: "attachment",
      entityId: id,
      patientId: r.patient_id,
    });
    return { filename: r.filename, mime: r.mime, data: r.data };
  });
}

/* ------------------------------------------------------------------ clôture et compte rendu (F4-6) */

export async function closeConsultation(
  db: Db,
  ctx: RequestContext,
  id: string,
): Promise<Consultation> {
  return withTransaction(db, async (tx) => {
    const row = await lock(tx, id);
    requireOwner(row, ctx);
    requireDraft(row);
    const before = await details(tx, toConsultation(row));
    if (!before.diagnoses || before.diagnoses.length === 0) {
      throw new DomainError(
        "diagnosis_required",
        "Un diagnostic codé est requis pour clôturer la consultation.",
        409,
      );
    }
    const patient = (await requireActivePatient(tx, row.patient_id).catch(
      () => null,
    )) as PatientSummary | null;
    const html = renderReport({
      consultation: before,
      patient,
      practitionerName: row.practitioner_name ?? row.practitioner_id,
    });
    const sha = createHash("sha256").update(html).digest("hex");
    await tx.query(
      "insert into clinical.documents (consultation_id, kind, html, sha256, created_by) values ($1, 'report', $2, $3, $4)",
      [id, html, sha, ctx.user.id],
    );
    const res = await tx.query<Row>(
      `update clinical.consultations set status = 'closed', closed_at = now(), closed_by = $2, version = version + 1, updated_at = now()
        where id = $1 returning ${COLUMNS}`,
      [id, ctx.user.id],
    );
    const closed = toConsultation(res.rows[0] as Row);
    await writeAudit(tx, ctx, {
      action: "consultation.close",
      entityType: "consultation",
      entityId: id,
      patientId: closed.patientId,
      detail: { diagnoses: before.diagnoses.map((d) => d.code), reportSha256: sha },
    });
    await appendEvent(tx, ctx, {
      type: "ConsultationClosed",
      patientId: closed.patientId,
      payload: {
        consultationId: id,
        encounterId: closed.encounterId,
        diagnosisCodes: before.diagnoses.map((d) => d.code),
        closedBy: { userId: ctx.user.id, name: ctx.user.name },
      },
    });
    return details(tx, closed);
  });
}

export async function getReport(
  db: Db,
  ctx: RequestContext,
  id: string,
): Promise<{ html: string; sha256: string; createdAt: string }> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<{ patient_id: string; status: string }>(
      "select patient_id, status from clinical.consultations where id = $1",
      [id],
    );
    const c = found.rows[0];
    if (!c) throw notFound("Consultation");
    if (c.status !== "closed")
      throw new DomainError("not_closed", "Le compte rendu existe après la clôture.", 409);
    const doc = await tx.query<{ html: string; sha256: string; created_at: Date }>(
      "select html, sha256, created_at from clinical.documents where consultation_id = $1 and kind = 'report' order by created_at desc limit 1",
      [id],
    );
    const d = doc.rows[0];
    if (!d) throw notFound("Compte rendu");
    await writeAudit(tx, ctx, {
      action: "report.read",
      entityType: "consultation",
      entityId: id,
      patientId: c.patient_id,
    });
    return { html: d.html, sha256: d.sha256, createdAt: d.created_at.toISOString() };
  });
}

/* ------------------------------------------------------------------ allergies */

export interface Allergy {
  id: string;
  patientId: string;
  substanceClass: string;
  label: string;
  severity: string;
  recordedAt: string;
}

/** Interface pour les autres modules : allergies actives du patient (et de ses dossiers fusionnés). */
export async function activeAllergies(tx: Tx | Db, patientId: string): Promise<Allergy[]> {
  const ids = await relatedPatientIds(tx, patientId);
  const res = await tx.query<{
    id: string;
    patient_id: string;
    substance_class: string;
    label: string;
    severity: string;
    recorded_at: Date;
  }>(
    `select id, patient_id, substance_class, label, severity, recorded_at from clinical.allergies
      where patient_id = any($1::uuid[]) and status = 'active' order by recorded_at`,
    [ids],
  );
  return res.rows.map((r) => ({
    id: r.id,
    patientId: r.patient_id,
    substanceClass: r.substance_class,
    label: r.label,
    severity: r.severity,
    recordedAt: r.recorded_at.toISOString(),
  }));
}

export async function addAllergy(
  db: Db,
  ctx: RequestContext,
  patientId: string,
  input: { substanceClass: string; label: string; severity: string },
): Promise<Allergy> {
  return withTransaction(db, async (tx) => {
    const patient = await requireActivePatient(tx, patientId);
    const dup = (await activeAllergies(tx, patient.id)).find(
      (a) => a.substanceClass === input.substanceClass,
    );
    if (dup)
      throw new DomainError("allergy_exists", "Cette allergie est déjà enregistrée.", 409, {
        allergyId: dup.id,
      });
    const res = await tx.query<{ id: string; recorded_at: Date }>(
      `insert into clinical.allergies (patient_id, substance_class, label, severity, recorded_by)
       values ($1, $2, $3, $4, $5) returning id, recorded_at`,
      [patient.id, input.substanceClass, input.label, input.severity, ctx.user.id],
    );
    const r = res.rows[0] as { id: string; recorded_at: Date };
    await writeAudit(tx, ctx, {
      action: "allergy.add",
      entityType: "allergy",
      entityId: r.id,
      patientId: patient.id,
      detail: { substanceClass: input.substanceClass, severity: input.severity },
    });
    return { id: r.id, patientId: patient.id, ...input, recordedAt: r.recorded_at.toISOString() };
  });
}

/** Une allergie saisie par erreur n'est jamais supprimée : elle est marquée « saisie par erreur ». */
export async function voidAllergy(db: Db, ctx: RequestContext, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const res = await tx.query<{ patient_id: string }>(
      `update clinical.allergies set status = 'entered_in_error', voided_by = $2, voided_at = now()
        where id = $1 and status = 'active' returning patient_id`,
      [id, ctx.user.id],
    );
    if (!res.rows[0]) throw notFound("Allergie");
    await writeAudit(tx, ctx, {
      action: "allergy.void",
      entityType: "allergy",
      entityId: id,
      patientId: res.rows[0].patient_id,
    });
  });
}

/* ------------------------------------------------------------------ bandeau patient (F4-1) */

export async function patientBanner(db: Db, ctx: RequestContext, ref: string) {
  const patient = await getPatient(db, ctx, ref);
  const showAllergies =
    can(ctx.user.roles, "clinical:read") || can(ctx.user.roles, "prescription:read");
  const allergies = showAllergies ? await activeAllergies(db, patient.id) : null;
  let age: number | null = null;
  if (patient.birthDate) {
    const b = new Date(`${patient.birthDate}T00:00:00Z`);
    const now = new Date();
    age =
      now.getUTCFullYear() -
      b.getUTCFullYear() -
      (now.getUTCMonth() < b.getUTCMonth() ||
      (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())
        ? 1
        : 0);
  }
  return {
    id: patient.id,
    identifier: patient.identifier,
    name: [patient.givenName, patient.familyName].filter(Boolean).join(" "),
    sex: patient.sex,
    age,
    ageEstimated: patient.ageEstimated,
    allergies: allergies
      ? allergies.map((a) => ({
          id: a.id,
          substanceClass: a.substanceClass,
          label: a.label,
          severity: a.severity,
        }))
      : null,
    redirectedFrom: patient.redirectedFrom ?? null,
  };
}

/* ------------------------------------------------------------------ modèles par spécialité (F4-4) */

export async function listTemplates(db: Db, specialty?: string) {
  const res = await db.query<{
    id: string;
    specialty: string;
    name: string;
    reason_text: string;
    exam_text: string;
  }>(
    `select id, specialty, name, reason_text, exam_text from clinical.templates
      where active and ($1::text is null or specialty = $1) order by specialty, name`,
    [specialty ?? null],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    specialty: r.specialty,
    name: r.name,
    reasonText: r.reason_text,
    examText: r.exam_text,
  }));
}

export async function saveTemplate(
  db: Db,
  ctx: RequestContext,
  input: { specialty: string; name: string; reasonText: string; examText: string },
): Promise<number> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `insert into clinical.templates (specialty, name, reason_text, exam_text) values ($1, $2, $3, $4)
       on conflict (specialty, name) do update set reason_text = excluded.reason_text, exam_text = excluded.exam_text, active = true
       returning id`,
      [input.specialty, input.name, input.reasonText, input.examText],
    );
    await writeAudit(tx, ctx, {
      action: "clinical.template",
      entityType: "template",
      entityId: (res.rows[0] as { id: string }).id,
      detail: { specialty: input.specialty, name: input.name },
    });
    return Number((res.rows[0] as { id: string }).id);
  });
}

/* ------------------------------------------------------------------ historique des consultations (source de l'historique du dossier) */

export interface ConsultationSummary {
  id: string;
  date: string;
  status: "draft" | "closed";
  practitionerName: string | null;
  reason: string;
  diagnosisCodes: string[];
}

export async function consultationSummaries(
  tx: Tx | Db,
  patientIds: string[],
): Promise<ConsultationSummary[]> {
  const res = await tx.query<{
    id: string;
    opened_at: Date;
    status: "draft" | "closed";
    practitioner_name: string | null;
    reason: string;
    codes: string[] | null;
  }>(
    `select c.id, c.opened_at, c.status, c.practitioner_name, c.reason,
            (select array_agg(d.code order by d.is_primary desc, d.code) from clinical.consultation_diagnoses d where d.consultation_id = c.id) as codes
       from clinical.consultations c where c.patient_id = any($1::uuid[]) order by c.opened_at desc limit 200`,
    [patientIds],
  );
  return res.rows.map((r) => ({
    id: r.id,
    date: r.opened_at.toISOString(),
    status: r.status,
    practitionerName: r.practitioner_name,
    reason: r.reason,
    diagnosisCodes: r.codes ?? [],
  }));
}

/** Interface pour le module des ordonnances : l'état d'une consultation. */
export async function consultationRef(
  tx: Tx | Db,
  id: string,
): Promise<{ id: string; patientId: string; status: "draft" | "closed"; practitionerId: string }> {
  const res = await tx.query<{
    id: string;
    patient_id: string;
    status: "draft" | "closed";
    practitioner_id: string;
  }>("select id, patient_id, status, practitioner_id from clinical.consultations where id = $1", [
    id,
  ]);
  const r = res.rows[0];
  if (!r) throw notFound("Consultation");
  return { id: r.id, patientId: r.patient_id, status: r.status, practitionerId: r.practitioner_id };
}
