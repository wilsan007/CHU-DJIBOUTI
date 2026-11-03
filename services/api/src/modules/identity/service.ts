import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { can } from "../../auth/permissions.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { cardPayload, parseCardPayload } from "./card.ts";
import { nameTokens, normalizeName, phoneDigits } from "./normalize.ts";
import type { CreatePatientInput, CreateProvisionalInput, MergeInput } from "./schemas.ts";
import {
  PATIENT_COLUMNS,
  toPatient,
  type DuplicateCandidate,
  type Patient,
  type PatientRow,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MERGE_CHAIN = 10;

function birthFromAge(estimatedAge: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - estimatedAge);
  // Au 1er juillet : milieu d'année, pour limiter l'erreur d'une année d'âge estimé.
  return `${d.getUTCFullYear()}-07-01`;
}

/* ------------------------------------------------------------------ doublons */

export async function findDuplicates(
  tx: Tx,
  nameNorm: string,
  birthDate: string,
  phone: string | null,
): Promise<DuplicateCandidate[]> {
  const res = await tx.query<PatientRow & { score: number }>(
    `select ${PATIENT_COLUMNS}, similarity(name_norm, $1) as score
       from identity.patients
      where status = 'active' and kind = 'regular' and name_norm % $1
        and (
          (similarity(name_norm, $1) >= 0.6
             and birth_date between ($2::date - interval '2 years') and ($2::date + interval '2 years'))
          or (phone_digits = $3 and similarity(name_norm, $1) >= 0.3)
        )
      order by score desc, created_at
      limit 5`,
    [nameNorm, birthDate, phone],
  );
  return res.rows.map((r) => ({ patient: toPatient(r), score: Number(r.score) }));
}

/* ------------------------------------------------------------------ création */

export async function createPatient(
  db: Db,
  ctx: RequestContext,
  input: CreatePatientInput,
): Promise<{ patient: Patient; created: boolean }> {
  if (input.externalId && !can(ctx.user.roles, "patient:import")) {
    throw new DomainError(
      "forbidden",
      "Seul un administrateur peut fournir un identifiant d'origine.",
      403,
    );
  }
  const ageEstimated = input.birthDate === undefined;
  const birthDate = input.birthDate ?? birthFromAge(input.estimatedAge as number);
  const digits = input.phone === undefined ? null : phoneDigits(input.phone);
  if (digits !== null && digits.length < 3) {
    throw new DomainError("validation_error", "Numéro de téléphone invalide.", 400);
  }
  const nameNorm = normalizeName(input.givenName, input.familyName);

  return withTransaction(db, async (tx) => {
    if (input.externalId) {
      const existing = await tx.query<PatientRow>(
        `select ${PATIENT_COLUMNS} from identity.patients where external_id = $1`,
        [input.externalId],
      );
      if (existing.rows[0]) return { patient: toPatient(existing.rows[0]), created: false };
    }
    if (!input.confirmNotDuplicate) {
      const candidates = await findDuplicates(tx, nameNorm, birthDate, digits);
      if (candidates.length > 0) {
        throw new DomainError(
          "possible_duplicates",
          "Un patient très proche existe déjà. Vérifiez avant de créer.",
          409,
          { candidates },
        );
      }
    }
    const res = await tx.query<PatientRow>(
      `insert into identity.patients
         (identifier, kind, external_id, given_name, family_name, sex, birth_date, age_estimated,
          phone, phone_digits, name_norm, created_by)
       values (lpad(nextval('identity.patient_number_seq')::text, 6, '0'), 'regular', $1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10)
       returning ${PATIENT_COLUMNS}`,
      [
        input.externalId ?? null,
        input.givenName,
        input.familyName,
        input.sex,
        birthDate,
        ageEstimated,
        input.phone ?? null,
        digits,
        nameNorm,
        ctx.user.id,
      ],
    );
    const patient = toPatient(res.rows[0] as PatientRow);
    await writeAudit(tx, ctx, {
      action: "patient.create",
      entityType: "patient",
      entityId: patient.id,
      patientId: patient.id,
      detail: {
        identifier: patient.identifier,
        forcedDespiteDuplicates: Boolean(input.confirmNotDuplicate),
      },
    });
    await appendEvent(tx, ctx, {
      type: "PatientCreated",
      patientId: patient.id,
      payload: {
        fhirResource: `Patient/${patient.id}`,
        identifier: patient.identifier,
        kind: "regular",
      },
    });
    return { patient, created: true };
  });
}

export async function createProvisionalPatient(
  db: Db,
  ctx: RequestContext,
  input: CreateProvisionalInput,
): Promise<Patient> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<PatientRow>(
      `insert into identity.patients
         (identifier, kind, sex, birth_date, age_estimated, note, created_by)
       values ('U-' || lpad(nextval('identity.provisional_number_seq')::text, 6, '0'), 'provisional',
               $1, $2, $3, $4, $5)
       returning ${PATIENT_COLUMNS}`,
      [
        input.sex ?? null,
        input.estimatedAge === undefined ? null : birthFromAge(input.estimatedAge),
        input.estimatedAge !== undefined,
        input.note ?? null,
        ctx.user.id,
      ],
    );
    const patient = toPatient(res.rows[0] as PatientRow);
    await writeAudit(tx, ctx, {
      action: "patient.create-provisional",
      entityType: "patient",
      entityId: patient.id,
      patientId: patient.id,
      detail: { identifier: patient.identifier },
    });
    await appendEvent(tx, ctx, {
      type: "PatientCreated",
      patientId: patient.id,
      payload: {
        fhirResource: `Patient/${patient.id}`,
        identifier: patient.identifier,
        kind: "provisional",
      },
    });
    return patient;
  });
}

/* ------------------------------------------------------------------ lecture */

async function fetchByRef(tx: Tx, ref: string, lock = false): Promise<PatientRow | undefined> {
  const where = UUID.test(ref) ? "id = $1::uuid" : "identifier = $1";
  const res = await tx.query<PatientRow>(
    `select ${PATIENT_COLUMNS} from identity.patients where ${where}${lock ? " for update" : ""}`,
    [UUID.test(ref) ? ref : ref.toUpperCase()],
  );
  return res.rows[0];
}

/** Ouvre un dossier par identifiant ou identifiant public. Un dossier fusionné renvoie le dossier survivant. */
export async function getPatient(
  db: Db,
  ctx: RequestContext,
  ref: string,
  via: "id" | "card" = "id",
): Promise<Patient> {
  return withTransaction(db, async (tx) => {
    let row = await fetchByRef(tx, ref);
    if (!row) throw notFound("Patient");
    const requested = row.identifier;
    let hops = 0;
    while (row.status === "merged") {
      hops += 1;
      if (hops > MAX_MERGE_CHAIN || !row.merged_into) {
        throw new DomainError("merge_chain", "Chaîne de fusion invalide.", 500);
      }
      const next = await fetchByRef(tx, row.merged_into);
      if (!next) throw notFound("Patient");
      row = next;
    }
    const patient = toPatient(row);
    if (requested !== patient.identifier) patient.redirectedFrom = requested;
    await writeAudit(tx, ctx, {
      action: "patient.read",
      entityType: "patient",
      entityId: patient.id,
      patientId: patient.id,
      detail: {
        via,
        ...(patient.redirectedFrom ? { redirectedFrom: patient.redirectedFrom } : {}),
      },
    });
    return patient;
  });
}

export function getCard(patient: Patient): { identifier: string; payload: string } {
  return { identifier: patient.identifier, payload: cardPayload(patient.identifier) };
}

export async function getPatientByCard(
  db: Db,
  ctx: RequestContext,
  payload: string,
): Promise<Patient> {
  const identifier = parseCardPayload(payload);
  if (!identifier) {
    throw new DomainError("invalid_card", "Code de carte illisible ou invalide.", 400);
  }
  return getPatient(db, ctx, identifier, "card");
}

/* ------------------------------------------------------------------ recherche */

export interface SearchHit {
  patient: Patient;
  score: number;
}

function toIsoDate(q: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q);
  if (iso) return q;
  const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(q);
  if (fr) return `${fr[3]}-${String(fr[2]).padStart(2, "0")}-${String(fr[1]).padStart(2, "0")}`;
  return null;
}

/**
 * Recherche tolérante aux fautes (histoire F1-2) : nom (variantes d'écriture, ordre libre, arabe ou latin),
 * téléphone, date de naissance, identifiant. Les dossiers fusionnés ne sont pas listés.
 */
export async function searchPatients(db: Db, query: string, limit = 20): Promise<SearchHit[]> {
  const q = query.trim();
  const client = await db.connect();
  try {
    const date = toIsoDate(q);
    if (date) {
      const res = await client.query<PatientRow>(
        `select ${PATIENT_COLUMNS} from identity.patients
          where status = 'active' and birth_date = $1::date order by family_name, given_name limit $2`,
        [date, limit],
      );
      return res.rows.map((r) => ({ patient: toPatient(r), score: 1 }));
    }
    const compact = q.replace(/[\s.-]+/g, "");
    if (/^U\d+$/i.test(compact)) {
      // Dossier provisoire : « U-000012 », « u12 »…
      const digits = compact.slice(1);
      const res = await client.query<PatientRow>(
        `select ${PATIENT_COLUMNS} from identity.patients
          where status = 'active' and kind = 'provisional'
            and (identifier = 'U-' || lpad($1, 6, '0') or identifier like 'U-' || $1 || '%')
          order by identifier limit $2`,
        [digits, limit],
      );
      return res.rows.map((r) => ({ patient: toPatient(r), score: 1 }));
    }
    if (/^\d{2,}$/.test(compact)) {
      // Chiffres seuls : identifiant (avec ou sans zéros) ou fin du numéro de téléphone.
      const res = await client.query<PatientRow>(
        `select ${PATIENT_COLUMNS} from identity.patients
          where status = 'active'
            and ((kind = 'regular' and (identifier = lpad($1, 6, '0') or identifier like $1 || '%'))
                 or phone_digits like '%' || $1)
          order by (identifier = lpad($1, 6, '0')) desc, identifier limit $2`,
        [compact, limit],
      );
      return res.rows.map((r) => ({ patient: toPatient(r), score: 1 }));
    }
    const tokens = nameTokens(q).slice(0, 4);
    if (tokens.length === 0) return [];
    const conditions = tokens.map((_, i) => `$${i + 1} <% name_norm`).join(" and ");
    const score = `(${tokens.map((_, i) => `word_similarity($${i + 1}, name_norm)`).join(" + ")}) / ${tokens.length}`;
    await client.query("begin");
    await client.query("select set_config('pg_trgm.word_similarity_threshold', '0.45', true)");
    const res = await client.query<PatientRow & { score: number }>(
      `select ${PATIENT_COLUMNS}, ${score} as score
         from identity.patients
        where status = 'active' and ${conditions}
        order by score desc, family_name, given_name
        limit $${tokens.length + 1}`,
      [...tokens, limit],
    );
    await client.query("commit");
    return res.rows.map((r) => ({ patient: toPatient(r), score: Number(r.score) }));
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // pas de transaction ouverte
    }
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ fusion */

async function mergeInTx(
  tx: Tx,
  ctx: RequestContext,
  survivorRef: string,
  mergedRef: string,
  action: "patient.merge" | "patient.link-provisional",
  reason: string,
): Promise<Patient> {
  // Verrouillage dans un ordre fixe pour éviter les blocages croisés entre deux fusions simultanées.
  const refs = [survivorRef, mergedRef].sort();
  const locked = new Map<string, PatientRow>();
  for (const ref of refs) {
    const row = await fetchByRef(tx, ref, true);
    if (!row) throw notFound("Patient");
    locked.set(ref, row);
  }
  const survivor = locked.get(survivorRef) as PatientRow;
  const merged = locked.get(mergedRef) as PatientRow;
  if (survivor.id === merged.id) {
    throw new DomainError(
      "invalid_merge",
      "On ne peut pas fusionner un dossier avec lui-même.",
      400,
    );
  }
  if (survivor.status !== "active" || merged.status !== "active") {
    throw new DomainError("invalid_merge", "Un des deux dossiers est déjà fusionné.", 409);
  }
  if (survivor.kind !== "regular") {
    throw new DomainError("invalid_merge", "Le dossier conservé doit être un dossier normal.", 400);
  }
  await tx.query(
    "update identity.patients set status = 'merged', merged_into = $1, updated_at = now() where id = $2",
    [survivor.id, merged.id],
  );
  await writeAudit(tx, ctx, {
    action,
    entityType: "patient",
    entityId: merged.id,
    patientId: survivor.id,
    detail: { mergedId: merged.id, mergedIdentifier: merged.identifier, reason },
  });
  await appendEvent(tx, ctx, {
    type: "PatientMerged",
    patientId: survivor.id,
    payload: {
      survivorId: survivor.id,
      mergedId: merged.id,
      survivorIdentifier: survivor.identifier,
      mergedIdentifier: merged.identifier,
    },
  });
  return toPatient(survivor);
}

/** Histoire F1-4 : fusion de doublons, réservée à l'administration. L'ancien identifiant renvoie vers le nouveau. */
export async function mergePatients(
  db: Db,
  ctx: RequestContext,
  input: MergeInput,
): Promise<Patient> {
  return withTransaction(db, (tx) =>
    mergeInTx(tx, ctx, input.survivorId, input.mergedId, "patient.merge", input.reason),
  );
}

/** Histoire F1-5 : rattache un dossier provisoire à un vrai dossier, sans perte d'historique. */
export async function linkProvisional(
  db: Db,
  ctx: RequestContext,
  provisionalRef: string,
  patientId: string,
): Promise<Patient> {
  return withTransaction(db, async (tx) => {
    const provisional = await fetchByRef(tx, provisionalRef);
    if (!provisional) throw notFound("Dossier provisoire");
    if (provisional.kind !== "provisional") {
      throw new DomainError("invalid_link", "Ce dossier n'est pas un dossier provisoire.", 400);
    }
    return mergeInTx(
      tx,
      ctx,
      patientId,
      provisional.id,
      "patient.link-provisional",
      "rattachement",
    );
  });
}

/** Le patient accepte ou refuse les rappels par SMS ou WhatsApp. */
export async function setReminderPreference(
  db: Db,
  ctx: RequestContext,
  ref: string,
  optOut: boolean,
): Promise<{ identifier: string; reminderOptOut: boolean }> {
  return withTransaction(db, async (tx) => {
    const row = await fetchByRef(tx, ref, true);
    if (!row) throw notFound("Patient");
    if (row.status === "merged")
      throw new DomainError("patient_merged", "Dossier fusionné.", 409, {
        survivorId: row.merged_into,
      });
    await tx.query(
      "update identity.patients set reminder_opt_out = $2, updated_at = now() where id = $1",
      [row.id, optOut],
    );
    await writeAudit(tx, ctx, {
      action: "patient.preferences",
      entityType: "patient",
      entityId: row.id,
      patientId: row.id,
      detail: { reminderOptOut: optOut },
    });
    return { identifier: row.identifier, reminderOptOut: optOut };
  });
}
