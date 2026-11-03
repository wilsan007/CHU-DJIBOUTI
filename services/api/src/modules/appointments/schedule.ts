import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { isoWeekday, localDate, localToUtc, minutesOfDay } from "../../common/time.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { requireDepartment } from "../catalog/service.ts";

export interface Practitioner {
  id: string;
  displayName: string;
  departmentCode: string;
  active: boolean;
}

export interface AvailabilityRule {
  weekday: number;
  start: string;
  end: string;
  slotMinutes: number;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  status: "free" | "booked" | "absent";
}

const hhmm = (t: string) => t.slice(0, 5);

export async function requirePractitioner(tx: Tx | Db, id: string): Promise<Practitioner> {
  const res = await tx.query<{
    id: string;
    display_name: string;
    department_code: string;
    active: boolean;
  }>(
    "select id, display_name, department_code, active from appointments.practitioners where id = $1",
    [id],
  );
  const r = res.rows[0];
  if (!r) throw notFound("Praticien");
  if (!r.active)
    throw new DomainError("practitioner_inactive", "Ce praticien n'a plus d'agenda.", 409);
  return {
    id: r.id,
    displayName: r.display_name,
    departmentCode: r.department_code,
    active: r.active,
  };
}

export async function listPractitioners(db: Db, department?: string): Promise<Practitioner[]> {
  const res = await db.query<{
    id: string;
    display_name: string;
    department_code: string;
    active: boolean;
  }>(
    `select id, display_name, department_code, active from appointments.practitioners
      where ($1::text is null or department_code = $1) order by display_name`,
    [department ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    departmentCode: r.department_code,
    active: r.active,
  }));
}

export async function savePractitioner(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { displayName: string; departmentCode: string; active?: boolean | undefined },
): Promise<Practitioner> {
  return withTransaction(db, async (tx) => {
    await requireDepartment(tx, input.departmentCode);
    await tx.query(
      `insert into appointments.practitioners (id, display_name, department_code, active)
       values ($1, $2, $3, $4)
       on conflict (id) do update set display_name = excluded.display_name,
         department_code = excluded.department_code, active = excluded.active`,
      [id, input.displayName, input.departmentCode, input.active ?? true],
    );
    await writeAudit(tx, ctx, {
      action: "schedule.practitioner",
      entityType: "practitioner",
      entityId: id,
      detail: input,
    });
    return {
      id,
      displayName: input.displayName,
      departmentCode: input.departmentCode,
      active: input.active ?? true,
    };
  });
}

/** Remplace les horaires hebdomadaires d'un praticien. Deux plages du même jour ne se chevauchent pas. */
export async function setAvailability(
  db: Db,
  ctx: RequestContext,
  practitionerId: string,
  rules: AvailabilityRule[],
): Promise<AvailabilityRule[]> {
  for (const r of rules) {
    if (minutesOfDay(r.end) <= minutesOfDay(r.start)) {
      throw new DomainError("invalid_rule", "L'heure de fin doit suivre l'heure de début.", 400);
    }
  }
  for (const a of rules) {
    for (const b of rules) {
      if (
        a !== b &&
        a.weekday === b.weekday &&
        minutesOfDay(a.start) < minutesOfDay(b.end) &&
        minutesOfDay(b.start) < minutesOfDay(a.end)
      ) {
        throw new DomainError("overlapping_rules", "Deux plages du même jour se chevauchent.", 400);
      }
    }
  }
  return withTransaction(db, async (tx) => {
    await requirePractitioner(tx, practitionerId);
    await tx.query("delete from appointments.availability where practitioner_id = $1", [
      practitionerId,
    ]);
    for (const r of rules) {
      await tx.query(
        `insert into appointments.availability (practitioner_id, weekday, start_time, end_time, slot_minutes)
         values ($1, $2, $3, $4, $5)`,
        [practitionerId, r.weekday, r.start, r.end, r.slotMinutes],
      );
    }
    await writeAudit(tx, ctx, {
      action: "schedule.availability",
      entityType: "practitioner",
      entityId: practitionerId,
      detail: { rules },
    });
    return rules;
  });
}

export async function addAbsence(
  db: Db,
  ctx: RequestContext,
  practitionerId: string,
  input: { from: string; to: string; reason?: string | undefined },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await requirePractitioner(tx, practitionerId);
    await tx.query(
      "insert into appointments.absences (practitioner_id, from_date, to_date, reason) values ($1, $2, $3, $4)",
      [practitionerId, input.from, input.to, input.reason ?? null],
    );
    await writeAudit(tx, ctx, {
      action: "schedule.absence",
      entityType: "practitioner",
      entityId: practitionerId,
      detail: input,
    });
  });
}

/** Créneaux d'un jour local : libres, pris ou en absence. */
export async function slotsFor(tx: Tx | Db, practitionerId: string, date: string): Promise<Slot[]> {
  const rules = await tx.query<{ start_time: string; end_time: string; slot_minutes: number }>(
    `select start_time::text, end_time::text, slot_minutes from appointments.availability
      where practitioner_id = $1 and weekday = $2 order by start_time`,
    [practitionerId, isoWeekday(date)],
  );
  const absent = await tx.query(
    "select 1 from appointments.absences where practitioner_id = $1 and $2::date between from_date and to_date",
    [practitionerId, date],
  );
  const booked = await tx.query<{ starts_at: Date }>(
    `select starts_at from appointments.appointments
      where practitioner_id = $1 and status in ('booked', 'arrived')
        and starts_at >= $2 and starts_at < $3`,
    [
      practitionerId,
      localToUtc(date, "00:00"),
      new Date(localToUtc(date, "00:00").getTime() + 86_400_000),
    ],
  );
  const taken = new Set(booked.rows.map((b) => b.starts_at.getTime()));
  const slots: Slot[] = [];
  for (const r of rules.rows) {
    const startMin = minutesOfDay(hhmm(r.start_time));
    const endMin = minutesOfDay(hhmm(r.end_time));
    for (let m = startMin; m + r.slot_minutes <= endMin; m += r.slot_minutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const start = localToUtc(date, `${hh}:${mm}`);
      const end = new Date(start.getTime() + r.slot_minutes * 60_000);
      slots.push({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        status: absent.rowCount ? "absent" : taken.has(start.getTime()) ? "booked" : "free",
      });
    }
  }
  return slots;
}

/** Le créneau demandé existe-t-il dans l'agenda, hors absence et dans le futur ? */
export async function assertBookableSlot(
  tx: Tx | Db,
  practitionerId: string,
  startsAt: Date,
  now: Date = new Date(),
): Promise<{ endsAt: Date }> {
  if (startsAt.getTime() <= now.getTime()) {
    throw new DomainError("slot_in_past", "Ce créneau est passé.", 400);
  }
  const slots = await slotsFor(tx, practitionerId, localDate(startsAt));
  const slot = slots.find((s) => new Date(s.startsAt).getTime() === startsAt.getTime());
  if (!slot)
    throw new DomainError(
      "not_a_slot",
      "Ce n'est pas un créneau de l'agenda de ce praticien.",
      400,
    );
  if (slot.status === "absent")
    throw new DomainError("practitioner_absent", "Le praticien est absent ce jour-là.", 409);
  return { endsAt: new Date(slot.endsAt) };
}
