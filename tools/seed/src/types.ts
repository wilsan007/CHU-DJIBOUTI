/** Types du jeu de données fictif. Tout enregistrement porte `fictional: true`. */

export type Sex = "female" | "male";

export interface SeedPatient {
  externalId: string;
  fictional: true;
  givenName: string;
  familyName: string;
  sex: Sex;
  /** AAAA-MM-JJ */
  birthDate: string;
  /** Numéro volontairement invalide (commence par 00) : aucun SMS réel ne peut partir. */
  phone: string;
  /** Codes d'allergie fictifs, ex. "penicillin". */
  allergies: string[];
  /** Renseigné pour les homonymes volontaires servant à tester la détection de doublons. */
  intentionalDuplicateOf?: string;
}

export type AppointmentStatus = "completed" | "cancelled" | "scheduled" | "arrived";

export interface SeedAppointment {
  externalId: string;
  fictional: true;
  patientId: string;
  /** AAAA-MM-JJ */
  date: string;
  /** HH:MM */
  time: string;
  service: "consultation-externe" | "urgences" | "maternite";
  reason: string;
  status: AppointmentStatus;
}

export interface SeedPrescriptionLine {
  drug: string;
  dosePerTake: number;
  perDay: number;
  days: number;
  route: "orale" | "injectable" | "cutanee";
}

export interface SeedPrescription {
  externalId: string;
  fictional: true;
  patientId: string;
  issuedAt: string;
  lines: SeedPrescriptionLine[];
}

export type LabFlag = "low" | "normal" | "high" | "critical";

export interface SeedLabResult {
  code: string;
  value: number;
  unit: string;
  flag: LabFlag;
}

export interface SeedLabOrder {
  externalId: string;
  fictional: true;
  patientId: string;
  orderedAt: string;
  status: "received" | "validated";
  results: SeedLabResult[];
}

export interface SeedDataset {
  meta: {
    generator: string;
    seed: number;
    referenceDate: string;
    notice: string;
  };
  patients: SeedPatient[];
  appointments: SeedAppointment[];
  prescriptions: SeedPrescription[];
  labOrders: SeedLabOrder[];
}

export interface GenerateOptions {
  count: number;
  seed: number;
  /** Date de référence fixe (AAAA-MM-JJ) : jamais l'horloge, pour un résultat reproductible. */
  referenceDate: string;
  /** Nombre de paires d'homonymes volontaires incluses dans `count`. */
  duplicatePairs: number;
}
