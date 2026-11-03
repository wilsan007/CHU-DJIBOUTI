import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { localDate } from "../../common/time.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import {
  patientSummaries,
  relatedPatientIds,
  requireActivePatient,
  type PatientSummary,
} from "../identity/interface.ts";
import { assertBookableSlot, requirePractitioner } from "./schedule.ts";

export interface Appointment {
  id: string;
  patientId: string;
  practitionerId: string;
  departmentCode: string;
  startsAt: string;
  endsAt: string;
  status: "booked" | "arrived" | "cancelled" | "completed" | "no_show";
  reason: string | null;
  rescheduledFrom: string | null;
  cancelReason: string | null;
  patient?: PatientSummary;
}

interface Row {
  id: string;
  patient_id: string;
  practitioner_id: string;
  department_code: string;
  starts_at: Date;
  ends_at: Date;
  status: Appointment["status"];
  reason: string | null;
  rescheduled_from: string | null;
  cancel_reason: string | null;
}

const COLUMNS =
  "id, patient_id, practitioner_id, department_code, starts_at, ends_at, status, reason, rescheduled_from, cancel_reason";

const toAppointment = (r: Row): Appointment => ({
  id: r.id,
  patientId: r.patient_id,
  practitionerId: r.practitioner_id,
  departmentCode: r.department_code,
  startsAt: r.starts_at.toISOString(),
  endsAt: r.ends_at.toISOString(),
  status: r.status,
  reason: r.reason,
  rescheduledFrom: r.rescheduled_from,
  cancelReason: r.cancel_reason,
});

const isSlotConflict = (error: unknown): boolean =>
  (error as { code?: string; constraint?: string }).code === "23505" &&
  (error as { constraint?: string }).constraint === "appointments_active_slot_idx";

const slotTaken = () =>
  new DomainError("slot_taken", "Ce créneau vient d'être pris. Choisissez-en un autre.", 409);

/** Réserve un créneau dans la transaction `tx`. */
async function bookInTx(
  tx: Tx,
  ctx: RequestContext,
  input: {
    patientId: string;
    practitionerId: string;
    startsAt: Date;
    reason?: string | null;
    rescheduledFrom?: string;
  },
  now: Date,
): Promise<Appointment> {
  const patient = await requireActivePatient(tx, input.patientId);
  const practitioner = await requirePractitioner(tx, input.practitionerId);
  const { endsAt } = await assertBookableSlot(tx, practitioner.id, input.startsAt, now);
  const res = await tx.query<Row>(
    `insert into appointments.appointments
       (patient_id, practitioner_id, department_code, starts_at, ends_at, reason, booked_by, rescheduled_from)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
    [
      patient.id,
      practitioner.id,
      practitioner.departmentCode,
      input.startsAt,
      endsAt,
      input.reason ?? null,
      ctx.user.id,
      input.rescheduledFrom ?? null,
    ],
  );
  const appointment = toAppointment(res.rows[0] as Row);
  await writeAudit(tx, ctx, {
    action: "appointment.book",
    entityType: "appointment",
    entityId: appointment.id,
    patientId: patient.id,
    detail: { practitionerId: practitioner.id, startsAt: appointment.startsAt },
  });
  await appendEvent(tx, ctx, {
    type: "AppointmentBooked",
    patientId: patient.id,
    payload: {
      appointmentId: appointment.id,
      departmentCode: practitioner.departmentCode,
      practitionerId: practitioner.id,
      startsAt: appointment.startsAt,
    },
  });
  return appointment;
}

export async function bookAppointment(
  db: Db,
  ctx: RequestContext,
  input: { patientId: string; practitionerId: string; startsAt: Date; reason?: string | null },
  now: Date = new Date(),
): Promise<Appointment> {
  try {
    return await withTransaction(db, (tx) => bookInTx(tx, ctx, input, now));
  } catch (error) {
    if (isSlotConflict(error)) throw slotTaken();
    throw error;
  }
}

async function cancelInTx(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  reason: string,
): Promise<Appointment> {
  const found = await tx.query<Row>(
    `select ${COLUMNS} from appointments.appointments where id = $1 for update`,
    [id],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Rendez-vous");
  if (row.status !== "booked") {
    throw new DomainError("not_cancellable", "Seul un rendez-vous à venir peut être annulé.", 409);
  }
  const res = await tx.query<Row>(
    `update appointments.appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = $2
      where id = $1 returning ${COLUMNS}`,
    [id, reason],
  );
  const appointment = toAppointment(res.rows[0] as Row);
  await writeAudit(tx, ctx, {
    action: "appointment.cancel",
    entityType: "appointment",
    entityId: id,
    patientId: appointment.patientId,
    detail: { reason },
  });
  await appendEvent(tx, ctx, {
    type: "AppointmentCancelled",
    patientId: appointment.patientId,
    payload: {
      appointmentId: id,
      departmentCode: appointment.departmentCode,
      practitionerId: appointment.practitionerId,
      startsAt: appointment.startsAt,
      reason,
    },
  });
  return appointment;
}

/** F3-5 : l'annulation libère le créneau (la liste d'attente est prévenue par le distributeur). */
export async function cancelAppointment(
  db: Db,
  ctx: RequestContext,
  id: string,
  reason: string,
): Promise<Appointment> {
  return withTransaction(db, (tx) => cancelInTx(tx, ctx, id, reason));
}

/** F3-5 : report atomique. Si le nouveau créneau est pris, l'ancien rendez-vous reste intact. */
export async function rescheduleAppointment(
  db: Db,
  ctx: RequestContext,
  id: string,
  startsAt: Date,
  now: Date = new Date(),
): Promise<{ previous: Appointment; appointment: Appointment }> {
  try {
    return await withTransaction(db, async (tx) => {
      const found = await tx.query<Row>(
        `select ${COLUMNS} from appointments.appointments where id = $1 for update`,
        [id],
      );
      const old = found.rows[0];
      if (!old) throw notFound("Rendez-vous");
      if (old.status !== "booked")
        throw new DomainError(
          "not_cancellable",
          "Seul un rendez-vous à venir peut être reporté.",
          409,
        );
      if (old.starts_at.getTime() === startsAt.getTime()) {
        throw new DomainError("same_slot", "Choisissez un autre créneau.", 400);
      }
      const appointment = await bookInTx(
        tx,
        ctx,
        {
          patientId: old.patient_id,
          practitionerId: old.practitioner_id,
          startsAt,
          reason: old.reason,
          rescheduledFrom: id,
        },
        now,
      );
      const previous = await cancelInTx(tx, ctx, id, "reporté");
      return { previous, appointment };
    });
  } catch (error) {
    if (isSlotConflict(error)) throw slotTaken();
    throw error;
  }
}

export async function listAppointments(
  db: Db,
  filter: { practitionerId?: string; date?: string; patientId?: string; status?: string },
): Promise<Appointment[]> {
  const ids = filter.patientId ? await relatedPatientIds(db, filter.patientId) : null;
  const res = await db.query<Row>(
    `select ${COLUMNS} from appointments.appointments
      where ($1::text is null or practitioner_id = $1)
        and ($2::uuid[] is null or patient_id = any($2))
        and ($3::text is null or status = $3)
        and ($4::date is null or (starts_at + interval '3 hours')::date = $4::date)
      order by starts_at limit 500`,
    [filter.practitionerId ?? null, ids, filter.status ?? null, filter.date ?? null],
  );
  const list = res.rows.map(toAppointment);
  const people = await patientSummaries(
    db,
    list.map((a) => a.patientId),
  );
  for (const a of list) {
    const p = people.get(a.patientId);
    if (p) a.patient = p;
  }
  return list;
}

/** Rendez-vous du jour d'un patient dans un service (pour la file d'attente). */
export async function todaysAppointment(
  tx: Tx,
  patientIds: string[],
  department: string,
  now: Date,
) {
  const res = await tx.query<{ id: string }>(
    `select id from appointments.appointments
      where patient_id = any($1::uuid[]) and department_code = $2 and status = 'booked'
        and (starts_at + interval '3 hours')::date = $3::date
      order by starts_at limit 1`,
    [patientIds, department, localDate(now)],
  );
  return res.rows[0]?.id ?? null;
}

/* ------------------------------------------------------------------ liste d'attente */

export interface WaitlistEntry {
  id: string;
  patientId: string;
  departmentCode: string;
  practitionerId: string | null;
  earliest: string;
  latest: string;
  status: "waiting" | "offered" | "booked" | "cancelled";
  offeredPractitionerId: string | null;
  offeredSlot: string | null;
}

interface WaitRow {
  id: string;
  patient_id: string;
  department_code: string;
  practitioner_id: string | null;
  earliest: string;
  latest: string;
  status: WaitlistEntry["status"];
  offered_practitioner_id: string | null;
  offered_slot: Date | null;
}

const WAIT_COLUMNS =
  "id, patient_id, department_code, practitioner_id, earliest::text, latest::text, status, offered_practitioner_id, offered_slot";
const toWait = (r: WaitRow): WaitlistEntry => ({
  id: r.id,
  patientId: r.patient_id,
  departmentCode: r.department_code,
  practitionerId: r.practitioner_id,
  earliest: r.earliest,
  latest: r.latest,
  status: r.status,
  offeredPractitionerId: r.offered_practitioner_id,
  offeredSlot: r.offered_slot ? r.offered_slot.toISOString() : null,
});

export async function addToWaitlist(
  db: Db,
  ctx: RequestContext,
  input: {
    patientId: string;
    departmentCode: string;
    practitionerId?: string;
    earliest: string;
    latest: string;
  },
): Promise<WaitlistEntry> {
  return withTransaction(db, async (tx) => {
    const patient = await requireActivePatient(tx, input.patientId);
    if (input.practitionerId) await requirePractitioner(tx, input.practitionerId);
    const res = await tx.query<WaitRow>(
      `insert into appointments.waitlist (patient_id, department_code, practitioner_id, earliest, latest, created_by)
       values ($1, $2, $3, $4, $5, $6) returning ${WAIT_COLUMNS}`,
      [
        patient.id,
        input.departmentCode,
        input.practitionerId ?? null,
        input.earliest,
        input.latest,
        ctx.user.id,
      ],
    );
    const entry = toWait(res.rows[0] as WaitRow);
    await writeAudit(tx, ctx, {
      action: "waitlist.add",
      entityType: "waitlist",
      entityId: entry.id,
      patientId: patient.id,
    });
    return entry;
  });
}

/** Le patient accepte le créneau proposé : il est réservé s'il est encore libre. */
export async function acceptWaitlistOffer(
  db: Db,
  ctx: RequestContext,
  id: string,
  now: Date = new Date(),
): Promise<Appointment> {
  const result = await withTransaction(db, async (tx) => {
    const found = await tx.query<WaitRow>(
      `select ${WAIT_COLUMNS} from appointments.waitlist where id = $1 for update`,
      [id],
    );
    const entry = found.rows[0];
    if (!entry) throw notFound("Entrée de la liste d'attente");
    if (entry.status !== "offered" || !entry.offered_slot || !entry.offered_practitioner_id) {
      throw new DomainError("no_offer", "Aucun créneau n'est proposé pour cette entrée.", 409);
    }
    try {
      const appointment = await bookInTx(
        tx,
        ctx,
        {
          patientId: entry.patient_id,
          practitionerId: entry.offered_practitioner_id,
          startsAt: entry.offered_slot,
        },
        now,
      );
      await tx.query("update appointments.waitlist set status = 'booked' where id = $1", [id]);
      return { appointment } as const;
    } catch (error) {
      if (isSlotConflict(error)) return { conflict: true } as const;
      throw error;
    }
  });
  if ("conflict" in result) {
    await db.query(
      "update appointments.waitlist set status = 'waiting', offered_slot = null, offered_practitioner_id = null where id = $1",
      [id],
    );
    throw slotTaken();
  }
  return result.appointment;
}
