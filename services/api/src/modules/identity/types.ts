export interface Patient {
  id: string;
  identifier: string;
  kind: "regular" | "provisional";
  status: "active" | "merged";
  mergedInto: string | null;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  sex: "female" | "male" | null;
  birthDate: string | null;
  ageEstimated: boolean;
  phone: string | null;
  note: string | null;
  createdAt: string;
  /** Renseigné quand on a demandé un dossier fusionné : l'identifiant d'origine. */
  redirectedFrom?: string;
}

export interface PatientRow {
  id: string;
  identifier: string;
  kind: "regular" | "provisional";
  status: "active" | "merged";
  merged_into: string | null;
  external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  sex: "female" | "male" | null;
  birth_date: string | null;
  age_estimated: boolean;
  phone: string | null;
  note: string | null;
  created_at: Date;
}

export function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    identifier: row.identifier,
    kind: row.kind,
    status: row.status,
    mergedInto: row.merged_into,
    externalId: row.external_id,
    givenName: row.given_name,
    familyName: row.family_name,
    sex: row.sex,
    birthDate: row.birth_date,
    ageEstimated: row.age_estimated,
    phone: row.phone,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

export const PATIENT_COLUMNS = `id, identifier, kind, status, merged_into, external_id, given_name, family_name,
  sex, birth_date, age_estimated, phone, note, created_at`;

export interface DuplicateCandidate {
  patient: Patient;
  score: number;
}
