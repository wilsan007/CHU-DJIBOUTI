import { localDate } from "../../common/time.ts";
import { appendEvent } from "../../events/outbox.ts";
import type { Consumer } from "../../events/dispatcher.ts";
import { writeAudit } from "../../audit/audit.ts";
import { enqueueArrival } from "./queue.ts";

const REMINDER_HOURS_BEFORE = Number(process.env.REMINDER_HOURS_BEFORE ?? 24);

/** Un patient admis entre dans la file d'attente de son service. */
export const queueOnAdmission: Consumer = {
  name: "appointments.queue-on-admission",
  types: ["EncounterStarted"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "EncounterStarted" || !event.patientId) return;
    const entry = await enqueueArrival(
      tx,
      {
        patientId: event.patientId,
        departmentCode: event.payload.departmentCode,
        encounterId: event.payload.encounterId,
      },
      new Date(event.occurredAt),
    );
    if (entry) {
      await writeAudit(tx, ctx, {
        action: "queue.enqueue",
        entityType: "queue_entry",
        entityId: entry.id,
        patientId: event.patientId,
        detail: { ticket: entry.ticket, priority: entry.priority },
      });
    }
  },
};

/** Programme le rappel d'un rendez-vous (24 h avant par défaut). */
export const scheduleReminder: Consumer = {
  name: "appointments.schedule-reminder",
  types: ["AppointmentBooked"],
  handle: async (event, tx) => {
    if (event.type !== "AppointmentBooked" || !event.patientId) return;
    const starts = new Date(event.payload.startsAt);
    const due = new Date(
      Math.max(starts.getTime() - REMINDER_HOURS_BEFORE * 3_600_000, Date.now()),
    );
    await tx.query(
      `insert into appointments.reminders (appointment_id, patient_id, kind, due_at)
       values ($1, $2, 'reminder', $3) on conflict (appointment_id, kind) do nothing`,
      [event.payload.appointmentId, event.patientId, due],
    );
  },
};

/** Un créneau libéré est proposé au premier patient de la liste d'attente qui peut le prendre. */
export const offerFreedSlot: Consumer = {
  name: "appointments.offer-freed-slot",
  types: ["AppointmentCancelled"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "AppointmentCancelled") return;
    const { practitionerId, departmentCode, startsAt } = event.payload;
    const slot = new Date(startsAt);
    if (slot.getTime() <= Date.now()) return;
    const taken = await tx.query(
      "select 1 from appointments.appointments where practitioner_id = $1 and starts_at = $2 and status in ('booked', 'arrived')",
      [practitionerId, slot],
    );
    if (taken.rowCount) return;
    const day = localDate(slot);
    const next = await tx.query<{ id: string; patient_id: string }>(
      `select id, patient_id from appointments.waitlist
        where status = 'waiting' and department_code = $1 and (practitioner_id is null or practitioner_id = $2)
          and $3::date between earliest and latest
        order by created_at limit 1 for update skip locked`,
      [departmentCode, practitionerId, day],
    );
    const entry = next.rows[0];
    if (!entry) return;
    await tx.query(
      `update appointments.waitlist set status = 'offered', offered_practitioner_id = $2, offered_slot = $3, offered_at = now()
        where id = $1`,
      [entry.id, practitionerId, slot],
    );
    await tx.query(
      "insert into appointments.reminders (appointment_id, patient_id, kind, due_at) values (null, $1, 'waitlist_offer', now())",
      [entry.patient_id],
    );
    await writeAudit(tx, ctx, {
      action: "waitlist.offer",
      entityType: "waitlist",
      entityId: entry.id,
      patientId: entry.patient_id,
      detail: { practitionerId, startsAt },
    });
    await appendEvent(tx, ctx, {
      type: "WaitlistSlotOffered",
      patientId: entry.patient_id,
      payload: { waitlistEntryId: entry.id, practitionerId, startsAt },
    });
  },
};

/** Consultation clôturée : le patient sort de la file d'attente et son rendez-vous est honoré. */
export const closeQueueOnConsultation: Consumer = {
  name: "appointments.close-queue-on-consultation",
  types: ["ConsultationClosed"],
  handle: async (event, tx, ctx) => {
    if (event.type !== "ConsultationClosed") return;
    const res = await tx.query<{ id: string; appointment_id: string | null }>(
      `update appointments.queue_entries set status = 'done'
        where encounter_id = $1 and status in ('waiting', 'called', 'in_consultation')
        returning id, appointment_id`,
      [event.payload.encounterId],
    );
    for (const row of res.rows) {
      if (row.appointment_id) {
        await tx.query(
          "update appointments.appointments set status = 'completed' where id = $1 and status in ('booked', 'arrived')",
          [row.appointment_id],
        );
      }
      await writeAudit(tx, ctx, {
        action: "queue.done-by-consultation",
        entityType: "queue_entry",
        entityId: row.id,
        patientId: event.patientId,
      });
    }
  },
};

export const appointmentConsumers: Consumer[] = [
  queueOnAdmission,
  scheduleReminder,
  offerFreedSlot,
  closeQueueOnConsultation,
];
