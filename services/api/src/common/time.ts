import { LOCAL_OFFSET_HOURS } from "./money.ts";

/** Heures locales de Djibouti (UTC+3, sans heure d'été). Le stockage reste en UTC. */
const OFFSET_MS = LOCAL_OFFSET_HOURS * 3_600_000;

/** Jour local (AAAA-MM-JJ) d'un instant. */
export function localDate(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Jour ISO de la semaine : 1 = lundi ... 7 = dimanche. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Instant UTC correspondant à une date et une heure locales. */
export function localToUtc(date: string, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(
    Date.UTC(y as number, (mo as number) - 1, d as number, h as number, m as number) - OFFSET_MS,
  );
}

export function minutesOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h as number) * 60 + (m as number);
}

export function formatLocal(instant: Date): { date: string; time: string } {
  const local = new Date(instant.getTime() + OFFSET_MS).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}
