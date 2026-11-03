import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { localDate } from "../../common/time.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { patientSummaries, relatedPatientIds, type PatientSummary } from "../identity/interface.ts";
import { todaysAppointment } from "./service.ts";

export interface QueueEntry {
  id: string;
  patientId: string;
  encounterId: string | null;
  departmentCode: string;
  ticket: string;
  priority: 0 | 1 | 2;
  status: "waiting" | "called" | "in_consultation" | "done" | "left";
  arrivedAt: string;
  calledAt: string | null;
  waitingMinutes: number;
  patient?: PatientSummary;
}

interface Row {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  department_code: string;
  ticket: string;
  priority: 0 | 1 | 2;
  status: QueueEntry["status"];
  arrived_at: Date;
  called_at: Date | null;
}

const COLUMNS =
  "id, patient_id, encounter_id, department_code, ticket, priority, status, arrived_at, called_at";

const toEntry = (r: Row, now: Date): QueueEntry => ({
  id: r.id,
  patientId: r.patient_id,
  encounterId: r.encounter_id,
  departmentCode: r.department_code,
  ticket: r.ticket,
  priority: r.priority,
  status: r.status,
  arrivedAt: r.arrived_at.toISOString(),
  calledAt: r.called_at ? r.called_at.toISOString() : null,
  waitingMinutes: Math.max(0, Math.floor((now.getTime() - r.arrived_at.getTime()) / 60_000)),
});

/**
 * Entrée en file d'attente à l'arrivée du patient (événement EncounterStarted).
 * Urgences d'abord, puis les patients avec rendez-vous du jour, puis les autres, par ordre d'arrivée.
 */
export async function enqueueArrival(
  tx: Tx,
  input: { patientId: string; departmentCode: string; encounterId: string },
  now: Date = new Date(),
): Promise<QueueEntry | null> {
  const existing = await tx.query(
    "select 1 from appointments.queue_entries where encounter_id = $1",
    [input.encounterId],
  );
  if (existing.rowCount) return null;
  const family = await relatedPatientIds(tx, input.patientId);
  const appointmentId = await todaysAppointment(tx, family, input.departmentCode, now);
  const priority = input.departmentCode === "URG" ? 0 : appointmentId ? 1 : 2;
  const day = localDate(now);
  const counter = await tx.query<{ value: number }>(
    `insert into appointments.queue_counters (department_code, queue_date, value) values ($1, $2, 1)
       on conflict (department_code, queue_date) do update set value = appointments.queue_counters.value + 1
     returning value`,
    [input.departmentCode, day],
  );
  const number = (counter.rows[0] as { value: number }).value;
  const ticket = `${input.departmentCode}-${String(number).padStart(3, "0")}`;
  const res = await tx.query<Row>(
    `insert into appointments.queue_entries
       (patient_id, department_code, queue_date, number, ticket, priority, arrived_at, encounter_id, appointment_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLUMNS}`,
    [
      input.patientId,
      input.departmentCode,
      day,
      number,
      ticket,
      priority,
      now,
      input.encounterId,
      appointmentId,
    ],
  );
  if (appointmentId) {
    await tx.query("update appointments.appointments set status = 'arrived' where id = $1", [
      appointmentId,
    ]);
  }
  return toEntry(res.rows[0] as Row, now);
}

export async function listQueue(
  db: Db,
  department: string,
  now: Date = new Date(),
): Promise<QueueEntry[]> {
  const res = await db.query<Row>(
    `select ${COLUMNS} from appointments.queue_entries
      where department_code = $1 and queue_date = $2 and status in ('waiting', 'called', 'in_consultation')
      order by (status = 'waiting') desc, priority, arrived_at, number`,
    [department, localDate(now)],
  );
  const entries = res.rows.map((r) => toEntry(r, now));
  const people = await patientSummaries(
    db,
    entries.map((e) => e.patientId),
  );
  for (const e of entries) {
    const p = people.get(e.patientId);
    if (p) e.patient = p;
  }
  return entries;
}

/** Écran d'appel : seulement des numéros de ticket, jamais de noms. */
export async function displayBoard(db: Db, department: string, now: Date = new Date()) {
  const res = await db.query<{ ticket: string; status: string }>(
    `select ticket, status from appointments.queue_entries
      where department_code = $1 and queue_date = $2 and status in ('called', 'in_consultation')
      order by called_at desc nulls last limit 10`,
    [department, localDate(now)],
  );
  const next = await db.query<{ ticket: string }>(
    `select ticket from appointments.queue_entries
      where department_code = $1 and queue_date = $2 and status = 'waiting'
      order by priority, arrived_at limit 5`,
    [department, localDate(now)],
  );
  return { called: res.rows.map((r) => r.ticket), next: next.rows.map((r) => r.ticket) };
}

const TRANSITIONS: Record<string, { from: QueueEntry["status"][]; to: QueueEntry["status"] }> = {
  call: { from: ["waiting"], to: "called" },
  start: { from: ["called"], to: "in_consultation" },
  done: { from: ["in_consultation"], to: "done" },
  left: { from: ["waiting", "called"], to: "left" },
};

export async function moveQueueEntry(
  db: Db,
  ctx: RequestContext,
  id: string,
  action: "call" | "start" | "done" | "left",
  now: Date = new Date(),
): Promise<QueueEntry> {
  const rule = TRANSITIONS[action] as { from: QueueEntry["status"][]; to: QueueEntry["status"] };
  return withTransaction(db, async (tx) => {
    const found = await tx.query<Row>(
      `select ${COLUMNS} from appointments.queue_entries where id = $1 for update`,
      [id],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Entrée de la file");
    if (!rule.from.includes(row.status)) {
      throw new DomainError(
        "invalid_transition",
        `Action impossible : le patient est « ${row.status} ».`,
        409,
      );
    }
    const res = await tx.query<Row>(
      `update appointments.queue_entries
          set status = $2, called_at = case when $3 then $4::timestamptz else called_at end,
              called_by = case when $3 then $5 else called_by end
        where id = $1 returning ${COLUMNS}`,
      [id, rule.to, action === "call", now, ctx.user.id],
    );
    const entry = toEntry(res.rows[0] as Row, now);
    await writeAudit(tx, ctx, {
      action: `queue.${action}`,
      entityType: "queue_entry",
      entityId: id,
      patientId: entry.patientId,
      detail: { ticket: entry.ticket },
    });
    return entry;
  });
}
