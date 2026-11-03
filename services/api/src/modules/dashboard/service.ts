import type { RequestContext } from "../../audit/audit.ts";
import { writeAudit } from "../../audit/audit.ts";
import { localDate } from "../../common/time.ts";
import { withTransaction, type Db } from "../../db.ts";
import { headcount } from "../staff/service.ts";
import { alerts } from "../stock/service.ts";

/** Jour local de Djibouti (UTC+3) d'un horodatage SQL. */
const DAY = (column: string): string =>
  `((${column} at time zone 'UTC') + interval '3 hours')::date`;

const minutes = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 10) / 10;

/**
 * Tableau de bord de direction (F13-1) : uniquement des chiffres agrégés, jamais un dossier.
 * Chaque chiffre est calculé directement dans les tables sources, sans copie intermédiaire :
 * il est donc identique aux sources (un test le recompte indépendamment).
 */
export async function dashboard(db: Db, ctx: RequestContext, date?: string) {
  const day = date ?? localDate(new Date());
  const one = async (sql: string, params: unknown[] = [day]) =>
    (await db.query<Record<string, string | null>>(sql, params)).rows[0] ?? {};

  const admissions = await one(
    `select count(*) as n from billing.encounters where ${DAY("opened_at")} = $1::date`,
  );
  const closed = await one(
    `select count(*) as n from clinical.consultations where status = 'closed' and ${DAY("closed_at")} = $1::date`,
  );
  const placed = await one(
    `select count(*) as n from orders.service_orders where ${DAY("placed_at")} = $1::date`,
  );
  const released = await one(
    `select count(*) as n from orders.service_orders where released_at is not null and ${DAY("released_at")} = $1::date`,
  );
  const disp = await one(
    `select count(*) as n from pharmacy.dispensations where ${DAY("created_at")} = $1::date`,
  );
  const labCreated = await one(
    `select count(*) as n from lab.requests where ${DAY("created_at")} = $1::date`,
  );

  const pay = await db.query<{ method: string; n: string; amount: string }>(
    `select method, count(*) as n, coalesce(sum(amount), 0) as amount from billing.payments where ${DAY("paid_at")} = $1::date group by method`,
    [day],
  );
  const credits = await one(
    `select coalesce(sum(patient_amount), 0) as amount, count(*) as n from billing.invoices where kind = 'credit_note' and ${DAY("issued_at")} = $1::date`,
  );
  const byMethod: Record<string, { count: number; amount: number }> = {};
  for (const r of pay.rows) byMethod[r.method] = { count: Number(r.n), amount: Number(r.amount) };
  const collected = Object.values(byMethod).reduce((n, m) => n + m.amount, 0);
  const creditAmount = Number(credits.amount ?? 0);

  const stock = await alerts(db);
  const shortfalls = await one(
    `select count(*) as n from stock.shortfalls where resolved_at is null`,
    [],
  );
  const beds = await one(
    `select (select count(*) from hosp.beds where active) as total, (select count(*) from hosp.stays where status in ('admitted', 'discharge_pending')) as occupied`,
    [],
  );
  const admittedToday = await one(
    `select count(*) as n from hosp.stays where admitted_at is not null and ${DAY("admitted_at")} = $1::date`,
  );
  const dischargedToday = await one(
    `select count(*) as n from hosp.stays where exited_at is not null and ${DAY("exited_at")} = $1::date`,
  );
  const waitingNow = await one(
    `select count(*) as n from appointments.queue_entries where queue_date = $1::date and status = 'waiting'`,
  );
  const waits = await db.query<{ department_code: string; n: string; avg_min: string | null }>(
    `select department_code, count(*) as n, avg(extract(epoch from (called_at - arrived_at)) / 60) as avg_min
       from appointments.queue_entries where queue_date = $1::date and called_at is not null group by department_code order by department_code`,
    [day],
  );
  const overall = await one(
    `select avg(extract(epoch from (called_at - arrived_at)) / 60) as avg_min from appointments.queue_entries where queue_date = $1::date and called_at is not null`,
  );

  const pending = await one(
    `select count(*) as n, max(extract(epoch from (now() - created_at)) / 60) as oldest from lab.requests where status in ('pending', 'in_progress')`,
    [],
  );
  const turnaround = await one(
    `select count(*) as n, avg(extract(epoch from (done - created_at)) / 60) as avg_min from (
       select q.created_at, max(r.bio_at) as done from lab.requests q join lab.specimens s on s.request_id = q.id join lab.results r on r.specimen_id = s.id
        where q.status = 'completed' group by q.id) t where ${DAY("done")} = $1::date`,
  );

  await withTransaction(db, (tx) =>
    writeAudit(tx, ctx, {
      action: "dashboard.read",
      entityType: "dashboard",
      detail: { date: day },
    }),
  );
  const emergencyUnpaid = await one(
    `select count(*) as n from orders.service_orders o join billing.invoices i on i.order_id = o.id and i.kind = 'invoice'
      where o.emergency and i.status = 'pending'`,
    [],
  );
  const staff = await headcount(db, day);
  return {
    date: day,
    activity: {
      admissions: Number(admissions.n),
      consultationsClosed: Number(closed.n),
      ordersPlaced: Number(placed.n),
      ordersReleased: Number(released.n),
      emergencyUnpaid: Number(emergencyUnpaid.n),
      dispensations: Number(disp.n),
      labRequestsCreated: Number(labCreated.n),
    },
    revenue: {
      collected,
      byMethod,
      creditNotes: { count: Number(credits.n), amount: creditAmount },
      net: collected + creditAmount,
    },
    stock: {
      belowThreshold: stock.belowThreshold.length,
      expiredLots: stock.expiry.filter((e) => e.status === "expired").length,
      expiringLots: stock.expiry.filter((e) => e.status === "expiring").length,
      openShortfalls: Number(shortfalls.n),
    },
    staff,
    hospitalization: {
      totalBeds: Number(beds.total),
      occupiedBeds: Number(beds.occupied),
      admittedToday: Number(admittedToday.n),
      dischargedToday: Number(dischargedToday.n),
    },
    waiting: {
      waitingNow: Number(waitingNow.n),
      averageWaitMinutes: minutes(overall.avg_min ?? null),
      byDepartment: waits.rows.map((r) => ({
        department: r.department_code,
        called: Number(r.n),
        averageWaitMinutes: minutes(r.avg_min),
      })),
    },
    results: {
      pendingRequests: Number(pending.n),
      oldestPendingMinutes: minutes(pending.oldest ?? null),
      completedToday: Number(turnaround.n),
      averageTurnaroundMinutes: minutes(turnaround.avg_min ?? null),
    },
  };
}
