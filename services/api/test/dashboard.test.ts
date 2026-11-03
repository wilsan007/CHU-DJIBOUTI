import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  importClinicalCatalogs,
  makeCaller,
  newPatient,
  openCash,
  startConsultation,
  type Caller,
} from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const CASHIER = "caissier-tb";

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  await importClinicalCatalogs(call);
  await openCash(call, CASHIER);
});
after(async () => {
  await t.close();
  await db.drop();
});

const count = async (sql: string): Promise<number> => Number((await db.owner.query(sql)).rows[0].n);
const DAY = (c: string) =>
  `((${c} at time zone 'UTC') + interval '3 hours')::date = ((now() at time zone 'UTC') + interval '3 hours')::date`;

test("F13-1 : les chiffres du tableau de bord sont identiques aux sources, et la direction ne voit que des agrégats", async () => {
  // Activité réelle : admissions, consultation clôturée, demande payée, délivrance, attente.
  const c1 = await startConsultation(call, "dr-tb", "Dash1");
  await call(
    "doctor",
    "POST",
    `/api/consultations/${c1.consultation.id}/diagnoses`,
    { code: "E11", primary: true },
    "dr-tb",
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/consultations/${c1.consultation.id}/close`,
        undefined,
        "dr-tb",
      )
    ).status,
    200,
  );
  const c2 = await startConsultation(call, "dr-tb", "Dash2");
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    {
      patientId: c2.patient.id,
      encounterId: c2.encounterId,
      items: [{ actCode: "LAB-GLY", quantity: 1 }],
    },
    "dr-tb",
  );
  assert.equal(order.status, 201, order.raw);
  await t.dispatcher.drain();
  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${order.body.number}`,
    undefined,
    CASHIER,
  );
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
        { method: "cash", receivedAmount: 5000 },
        CASHIER,
      )
    ).status,
    200,
  );
  await t.dispatcher.drain();
  const p3 = await newPatient(call, "Dash3");
  await admitPatient(call, p3.id);

  // File d'attente : deux patients appelés après 7 et 11 minutes d'attente.
  await db.owner.query(
    `insert into appointments.queue_entries (patient_id, department_code, queue_date, number, ticket, priority, status, arrived_at, called_at)
     select $1, 'CONS', ((now() at time zone 'UTC') + interval '3 hours')::date, 900 + g, 'X' || g, 2, 'called',
            now() - interval '30 minutes', now() - interval '30 minutes' + (g * 4 + 3) * interval '1 minute' from generate_series(1, 2) g`,
    [p3.id],
  );

  const res = await call("direction", "GET", "/api/dashboard");
  assert.equal(res.status, 200, res.raw);
  const d = res.body;

  assert.equal(
    d.activity.admissions,
    await count(`select count(*) n from billing.encounters where ${DAY("opened_at")}`),
  );
  assert.equal(
    d.activity.consultationsClosed,
    await count(
      `select count(*) n from clinical.consultations where status = 'closed' and ${DAY("closed_at")}`,
    ),
  );
  assert.equal(d.activity.consultationsClosed, 1);
  assert.equal(
    d.activity.ordersPlaced,
    await count(`select count(*) n from orders.service_orders where ${DAY("placed_at")}`),
  );
  assert.equal(d.activity.ordersReleased, 1);
  assert.equal(
    d.activity.labRequestsCreated,
    await count(`select count(*) n from lab.requests where ${DAY("created_at")}`),
  );

  const paid = await count(
    `select coalesce(sum(amount), 0) n from billing.payments where ${DAY("paid_at")}`,
  );
  assert.equal(d.revenue.collected, paid);
  assert.equal(
    d.revenue.byMethod.cash.count,
    await count(
      `select count(*) n from billing.payments where method = 'cash' and ${DAY("paid_at")}`,
    ),
  );
  assert.equal(
    d.revenue.net,
    paid +
      (await count(
        `select coalesce(sum(patient_amount), 0) n from billing.invoices where kind = 'credit_note' and ${DAY("issued_at")}`,
      )),
  );
  assert.ok(d.revenue.collected >= 1500);

  assert.equal(
    d.waiting.byDepartment.find((x: { department: string }) => x.department === "CONS").called,
    2,
  );
  assert.equal(d.waiting.averageWaitMinutes, 9, "(7 + 11) / 2 minutes");
  assert.equal(
    d.waiting.waitingNow,
    await count(
      `select count(*) n from appointments.queue_entries where status = 'waiting' and queue_date = ((now() at time zone 'UTC') + interval '3 hours')::date`,
    ),
  );
  assert.equal(
    d.results.pendingRequests,
    await count("select count(*) n from lab.requests where status in ('pending','in_progress')"),
  );
  assert.equal(d.results.pendingRequests, 1);

  // Aucune donnée de patient dans la réponse.
  const text = JSON.stringify(d);
  assert.ok(!text.includes("Dash1") && !text.includes("Dash2"), "aucun nom de patient");
  assert.equal((await call("direction", "GET", "/api/patients?q=Dash")).status, 403);
  assert.equal(
    (await call("direction", "GET", `/api/consultations/${c1.consultation.id}`)).status,
    403,
  );
  assert.equal((await call("doctor", "GET", "/api/dashboard")).status, 403);
  assert.equal((await call("direction", "GET", "/api/dashboard?date=pas-une-date")).status, 400);
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'dashboard.read'")).rowCount,
    1,
  );
});

test("F13-1 : ruptures de stock et délais de résultats", async () => {
  const stock = await call("pharmacy", "POST", "/api/stock/receipts", {
    depot: "PC",
    lines: [
      {
        itemCode: "MET-500",
        lotNumber: "TB-1",
        expiresOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        quantity: 10,
      },
    ],
  });
  assert.equal(stock.status, 201, stock.raw);
  await call("pharmacy", "PUT", "/api/stock/thresholds/MET-500", { minimum: 50 });
  const d = (await call("direction", "GET", "/api/dashboard")).body;
  assert.equal(d.stock.belowThreshold, 1);
  assert.equal(d.stock.expiringLots, 1);

  // Un jour sans activité : zéros et valeurs nulles, pas d'erreur.
  const old = (await call("direction", "GET", "/api/dashboard?date=2020-01-01")).body;
  assert.equal(old.activity.admissions, 0);
  assert.equal(old.revenue.collected, 0);
  assert.equal(old.waiting.averageWaitMinutes, null);
});
