import type { Db, Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";

/**
 * Interface du module identité pour les autres modules : ils ne lisent jamais ses tables.
 * Ces lectures n'écrivent pas dans l'audit : le module appelant trace l'action qui en découle.
 */

export interface PatientSummary {
  id: string;
  identifier: string;
  kind: "regular" | "provisional";
  name: string;
  birthDate: string | null;
  sex: "female" | "male" | null;
}

interface Row {
  id: string;
  identifier: string;
  kind: "regular" | "provisional";
  status: "active" | "merged";
  merged_into: string | null;
  given_name: string | null;
  family_name: string | null;
  birth_date: string | null;
  sex: "female" | "male" | null;
}

function summary(r: Row): PatientSummary {
  const name = [r.given_name, r.family_name].filter(Boolean).join(" ") || `Inconnu ${r.identifier}`;
  return {
    id: r.id,
    identifier: r.identifier,
    kind: r.kind,
    name,
    birthDate: r.birth_date,
    sex: r.sex,
  };
}

/** Le patient existe et son dossier est actif. Un dossier fusionné est refusé : on utilise le dossier conservé. */
export async function requireActivePatient(tx: Tx | Db, id: string): Promise<PatientSummary> {
  const res = await tx.query<Row>(
    `select id, identifier, kind, status, merged_into, given_name, family_name, birth_date, sex
       from identity.patients where id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Patient");
  if (row.status === "merged") {
    throw new DomainError(
      "patient_merged",
      "Ce dossier a été fusionné : utilisez le dossier conservé.",
      409,
      { survivorId: row.merged_into },
    );
  }
  return summary(row);
}

/** Identité de plusieurs patients (pour l'affichage). Les dossiers fusionnés renvoient le dossier conservé. */
export async function patientSummaries(
  tx: Tx | Db,
  ids: readonly string[],
): Promise<Map<string, PatientSummary>> {
  const out = new Map<string, PatientSummary>();
  if (ids.length === 0) return out;
  const res = await tx.query<Row>(
    `select id, identifier, kind, status, merged_into, given_name, family_name, birth_date, sex
       from identity.patients where id = any($1::uuid[])`,
    [[...new Set(ids)]],
  );
  for (const r of res.rows) out.set(r.id, summary(r));
  return out;
}

/**
 * Le patient et tous les dossiers fusionnés dans le sien. Les modules qui gardent des données
 * immuables (factures, demandes) les retrouvent ainsi après une fusion, sans les réécrire.
 */
export async function relatedPatientIds(tx: Tx | Db, id: string): Promise<string[]> {
  const res = await tx.query<{ id: string }>(
    `with recursive up(id, merged_into) as (
       select id, merged_into from identity.patients where id = $1
       union all
       select p.id, p.merged_into from identity.patients p join up on p.id = up.merged_into
     ), root as (select id from up where merged_into is null limit 1),
     down(id) as (
       select id from root
       union all
       select p.id from identity.patients p join down on p.merged_into = down.id
     )
     select id from down`,
    [id],
  );
  return res.rows.length > 0 ? res.rows.map((r) => r.id) : [id];
}

/** Coordonnées pour un rappel : le numéro et le refus éventuel du patient. */
export async function getReminderContact(
  tx: Tx | Db,
  id: string,
): Promise<{ phone: string | null; optOut: boolean } | null> {
  const res = await tx.query<{ phone: string | null; reminder_opt_out: boolean }>(
    "select phone, reminder_opt_out from identity.patients where id = $1",
    [id],
  );
  const r = res.rows[0];
  return r ? { phone: r.phone, optOut: r.reminder_opt_out } : null;
}
