import {
  ANALYTES,
  APPOINTMENT_REASONS,
  DRUGS,
  FAMILY_NAMES,
  FEMALE_GIVEN_NAMES,
  MALE_GIVEN_NAMES,
  SERVICES,
  type AnalyteTemplate,
} from "./data.ts";
import { Prng } from "./prng.ts";
import type {
  AppointmentStatus,
  GenerateOptions,
  LabFlag,
  SeedAppointment,
  SeedDataset,
  SeedLabOrder,
  SeedLabResult,
  SeedPatient,
  SeedPrescription,
  Sex,
} from "./types.ts";

export const DEFAULT_OPTIONS: GenerateOptions = {
  count: 200,
  seed: 20261103,
  referenceDate: "2026-11-03",
  duplicatePairs: 6,
};

const DAY_MS = 86_400_000;

function parseDate(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Date invalide : ${iso}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function addDays(iso: string, delta: number): string {
  return new Date(parseDate(iso) + delta * DAY_MS).toISOString().slice(0, 10);
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** Âge en années entières à la date de référence. */
export function ageAt(birthDate: string, referenceDate: string): number {
  const b = new Date(parseDate(birthDate));
  const r = new Date(parseDate(referenceDate));
  let age = r.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    r.getUTCMonth() < b.getUTCMonth() ||
    (r.getUTCMonth() === b.getUTCMonth() && r.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function flagFor(a: AnalyteTemplate, value: number): LabFlag {
  if (value < a.criticalLow || value > a.criticalHigh) return "critical";
  if (value < a.low) return "low";
  if (value > a.high) return "high";
  return "normal";
}

/** Numéro invalide à dessein (préfixe 00) : un envoi de SMS ne peut joindre personne. */
function fictionalPhone(index: number): string {
  const digits = `00${pad(index, 6)}`;
  return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)}`;
}

function randomAge(rng: Prng): number {
  const bucket = rng.next();
  if (bucket < 0.15) return rng.int(0, 14);
  if (bucket < 0.7) return rng.int(15, 49);
  return rng.int(50, 90);
}

function buildPatients(rng: Prng, o: GenerateOptions): SeedPatient[] {
  const baseCount = o.count - o.duplicatePairs;
  const patients: SeedPatient[] = [];
  for (let i = 1; i <= baseCount; i += 1) {
    const sex: Sex = rng.chance(0.5) ? "female" : "male";
    const givenName = rng.pick(sex === "female" ? FEMALE_GIVEN_NAMES : MALE_GIVEN_NAMES);
    const birthDate = addDays(o.referenceDate, -(randomAge(rng) * 365 + rng.int(0, 364)));
    patients.push({
      externalId: `TEST-P-${pad(i, 6)}`,
      fictional: true,
      givenName,
      familyName: rng.pick(FAMILY_NAMES),
      sex,
      birthDate,
      phone: fictionalPhone(i),
      allergies: rng.chance(0.1) ? ["penicillin"] : [],
    });
  }
  // Homonymes volontaires : même nom et prénom, naissance à moins d'un an d'écart,
  // autre numéro. Ils servent à tester l'alerte de doublon et la fusion.
  const step = Math.max(1, Math.floor(baseCount / (o.duplicatePairs + 1)));
  for (let k = 0; k < o.duplicatePairs; k += 1) {
    const original = patients[(k + 1) * step - 1] as SeedPatient;
    patients.push({
      externalId: `TEST-P-${pad(baseCount + k + 1, 6)}`,
      fictional: true,
      givenName: original.givenName,
      familyName: original.familyName,
      sex: original.sex,
      birthDate: addDays(original.birthDate, rng.int(-150, 150)),
      phone: fictionalPhone(baseCount + k + 1),
      allergies: [],
      intentionalDuplicateOf: original.externalId,
    });
  }
  return patients;
}

function buildAppointments(
  rng: Prng,
  patients: SeedPatient[],
  o: GenerateOptions,
): SeedAppointment[] {
  const out: SeedAppointment[] = [];
  for (const p of patients) {
    if (!rng.chance(0.7)) continue;
    const n = rng.int(1, 3);
    for (let j = 0; j < n; j += 1) {
      const offset = rng.int(-90, 14);
      const date = addDays(o.referenceDate, offset);
      let status: AppointmentStatus;
      if (offset < 0) status = rng.chance(0.85) ? "completed" : "cancelled";
      else if (offset === 0) status = "arrived";
      else status = "scheduled";
      const hour = rng.int(8, 15);
      const minute = rng.chance(0.5) ? "00" : "30";
      out.push({
        externalId: `TEST-A-${pad(out.length + 1, 6)}`,
        fictional: true,
        patientId: p.externalId,
        date,
        time: `${pad(hour, 2)}:${minute}`,
        service: rng.pick(SERVICES),
        reason: rng.pick(APPOINTMENT_REASONS),
        status,
      });
    }
  }
  return out;
}

function buildPrescriptions(
  rng: Prng,
  patients: SeedPatient[],
  o: GenerateOptions,
): SeedPrescription[] {
  const out: SeedPrescription[] = [];
  for (const p of patients) {
    if (!rng.chance(0.5)) continue;
    // Jamais de médicament en conflit avec une allergie du patient : le jeu reste cohérent.
    const allowed = DRUGS.filter(
      (d) => d.allergyClass === null || !p.allergies.includes(d.allergyClass),
    );
    const pool = [...allowed];
    const lineCount = Math.min(rng.int(1, 3), pool.length);
    const lines = [];
    for (let k = 0; k < lineCount; k += 1) {
      const drug = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      if (!drug) break;
      lines.push({
        drug: drug.name,
        dosePerTake: drug.dosePerTake,
        perDay: drug.perDay,
        days: drug.days,
        route: "orale" as const,
      });
    }
    out.push({
      externalId: `TEST-R-${pad(out.length + 1, 6)}`,
      fictional: true,
      patientId: p.externalId,
      issuedAt: addDays(o.referenceDate, -rng.int(0, 90)),
      lines,
    });
  }
  return out;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function analyteValue(rng: Prng, a: AnalyteTemplate): number {
  const draw = rng.next();
  let value: number;
  if (draw < 0.82) {
    value = a.low + rng.next() * (a.high - a.low);
  } else if (draw < 0.9) {
    value = a.criticalLow + (a.low - a.criticalLow) * (0.2 + 0.6 * rng.next());
  } else if (draw < 0.97) {
    value = a.high + (a.criticalHigh - a.high) * (0.1 + 0.6 * rng.next());
  } else if (a.criticalLow > 0 && rng.chance(0.5)) {
    value = a.criticalLow * (0.5 + 0.4 * rng.next());
  } else {
    value = a.criticalHigh * (1.05 + 0.3 * rng.next());
  }
  return round(value, a.decimals);
}

function buildLabOrders(rng: Prng, patients: SeedPatient[], o: GenerateOptions): SeedLabOrder[] {
  const out: SeedLabOrder[] = [];
  for (const p of patients) {
    if (!rng.chance(0.6)) continue;
    const pool = [...ANALYTES];
    const testCount = rng.int(1, pool.length);
    const validated = rng.chance(0.85);
    const results: SeedLabResult[] = [];
    for (let k = 0; k < testCount; k += 1) {
      const a = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      if (!a) break;
      if (!validated) continue;
      const value = analyteValue(rng, a);
      results.push({ code: a.code, value, unit: a.unit, flag: flagFor(a, value) });
    }
    out.push({
      externalId: `TEST-L-${pad(out.length + 1, 6)}`,
      fictional: true,
      patientId: p.externalId,
      orderedAt: addDays(o.referenceDate, -rng.int(0, 60)),
      status: validated ? "validated" : "received",
      results,
    });
  }
  return out;
}

/** Produit le jeu de données. Fonction pure : mêmes options, même résultat, octet pour octet. */
export function generateDataset(options: Partial<GenerateOptions> = {}): SeedDataset {
  const o: GenerateOptions = { ...DEFAULT_OPTIONS, ...options };
  if (!Number.isInteger(o.count) || o.count < 1)
    throw new Error("count doit être un entier positif");
  if (
    !Number.isInteger(o.duplicatePairs) ||
    o.duplicatePairs < 0 ||
    o.duplicatePairs * 2 > o.count
  ) {
    throw new Error("duplicatePairs doit permettre d'avoir autant d'originaux que de copies");
  }
  parseDate(o.referenceDate);
  const rng = new Prng(o.seed);
  const patients = buildPatients(rng, o);
  return {
    meta: {
      generator: "chu-seed/1",
      seed: o.seed,
      referenceDate: o.referenceDate,
      notice:
        "Données fictives sans valeur clinique. Ne jamais les mélanger à des données réelles.",
    },
    patients,
    appointments: buildAppointments(rng, patients, o),
    prescriptions: buildPrescriptions(rng, patients, o),
    labOrders: buildLabOrders(rng, patients, o),
  };
}
