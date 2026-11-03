/**
 * Listes de référence du générateur. Données d'exemple SANS valeur clinique :
 * les doses, valeurs et plages sont des illustrations, à remplacer par les listes
 * validées par le comité médical (étiquette A-VALIDER-MEDECIN du plan).
 */

export const FEMALE_GIVEN_NAMES = [
  "Fatouma",
  "Hodan",
  "Amina",
  "Khadija",
  "Samira",
  "Ayan",
  "Idil",
  "Mariam",
  "Asha",
  "Nimo",
  "Safia",
  "Lul",
  "Sagal",
  "Roda",
  "Fadumo",
] as const;

export const MALE_GIVEN_NAMES = [
  "Abdi",
  "Mohamed",
  "Ahmed",
  "Ismaël",
  "Houssein",
  "Omar",
  "Ali",
  "Abdillahi",
  "Moussa",
  "Kadar",
  "Youssouf",
  "Idriss",
  "Hassan",
  "Said",
  "Mahad",
] as const;

export const FAMILY_NAMES = [
  "Dirir",
  "Warsama",
  "Robleh",
  "Houssein",
  "Ibrahim",
  "Ali",
  "Moussa",
  "Hassan",
  "Osman",
  "Farah",
  "Doualeh",
  "Abdallah",
  "Guedi",
  "Barkhad",
  "Mahamoud",
  "Djama",
  "Awaleh",
  "Elmi",
] as const;

export const SERVICES = ["consultation-externe", "urgences", "maternite"] as const;

export const APPOINTMENT_REASONS = [
  "Contrôle de routine",
  "Première visite",
  "Résultats d'analyses",
  "Suivi de traitement",
  "Fièvre",
  "Douleur",
] as const;

export interface DrugTemplate {
  name: string;
  /** Classe utilisée pour éviter toute ordonnance en conflit avec une allergie du patient. */
  allergyClass: string | null;
  dosePerTake: number;
  perDay: number;
  days: number;
}

export const DRUGS: readonly DrugTemplate[] = [
  { name: "Azithromycine 250 mg", allergyClass: null, dosePerTake: 1, perDay: 1, days: 3 },
  { name: "Amoxicilline 500 mg", allergyClass: "penicillin", dosePerTake: 1, perDay: 3, days: 5 },
  { name: "Paracétamol 500 mg", allergyClass: null, dosePerTake: 1, perDay: 3, days: 3 },
  { name: "Metformine 500 mg", allergyClass: null, dosePerTake: 1, perDay: 2, days: 30 },
];

export interface AnalyteTemplate {
  code: string;
  unit: string;
  /** Plage de référence d'EXEMPLE. */
  low: number;
  high: number;
  /** Seuils critiques d'EXEMPLE. */
  criticalLow: number;
  criticalHigh: number;
  decimals: number;
}

export const ANALYTES: readonly AnalyteTemplate[] = [
  {
    code: "glycemie",
    unit: "g/L",
    low: 0.7,
    high: 1.1,
    criticalLow: 0.4,
    criticalHigh: 2.5,
    decimals: 2,
  },
  {
    code: "hemoglobine",
    unit: "g/dL",
    low: 12,
    high: 16,
    criticalLow: 7,
    criticalHigh: 20,
    decimals: 1,
  },
  {
    code: "creatinine",
    unit: "mg/L",
    low: 6,
    high: 12,
    criticalLow: 0,
    criticalHigh: 40,
    decimals: 1,
  },
];
