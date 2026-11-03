import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  makeCaller,
  newPatient,
  openCash,
  type Caller,
} from "./support/scenario.ts";

/**
 * Règle de la caisse (ADR-0002) : le médecin demande des prestations, la caisse encaisse et valide,
 * et seulement alors le service concerné reçoit son ticket. Tout est tracé.
 */

let db: TestDatabase;
let t: TestApp;
let call: Caller;

const DOCTOR = "dr-aden";
const CASHIER = "caissier-principal";
const LAB = "technicien-labo";
const IMAGING = "technicien-radio";

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  await openCash(call, CASHIER);
});
after(async () => {
  await t.close();
  await db.drop();
});

async function consultedPatient(payer = "DIRECT") {
  const patient = await newPatient(call);
  const admission = await admitPatient(call, patient.id, { payer });
  return { patient, encounterId: admission.encounter.id };
}

async function place(
  patientId: string,
  encounterId: string,
  items: { actCode: string; quantity: number }[],
  sub = DOCTOR,
) {
  return call("doctor", "POST", "/api/service-orders", { patientId, encounterId, items }, sub);
}

const pendingInvoiceOf = async (orderNumber: string) => {
  const res = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${orderNumber}`,
    undefined,
    CASHIER,
  );
  assert.equal(res.status, 200, res.raw);
  return res.body.invoices[0];
};

test("la règle de la caisse : de la demande du médecin à l'activation du service, étape par étape", async () => {
  const { patient, encounterId } = await consultedPatient();

  // 1. Le médecin demande une analyse (deux actes) et une radio.
  const order = await place(patient.id, encounterId, [
    { actCode: "LAB-GLY", quantity: 1 },
    { actCode: "LAB-NFS", quantity: 1 },
    { actCode: "IMG-RX", quantity: 1 },
  ]);
  assert.equal(order.status, 201, order.raw);
  assert.equal(order.body.status, "awaiting_payment");
  assert.match(order.body.number, /^O-\d{6}$/);
  assert.deepEqual(
    order.body.items.map((i: { departmentCode: string }) => i.departmentCode).sort(),
    ["IMG", "LAB", "LAB"],
  );

  // 2. La facture arrive à la caisse (par le distributeur d'événements), avec le numéro de la demande.
  await t.dispatcher.drain();
  const invoice = await pendingInvoiceOf(order.body.number);
  assert.equal(invoice.total, 10000);
  assert.equal(invoice.patientAmount, 10000);
  assert.equal(invoice.orderNumber, order.body.number);
  assert.equal(invoice.patient.identifier, patient.identifier);

  // 3. Avant le paiement : aucun ticket nulle part, aucun bon pour le patient, aucun service ne peut démarrer.
  assert.deepEqual(
    (await call("lab", "GET", "/api/department-tickets?department=LAB", undefined, LAB)).body
      .tickets,
    [],
  );
  assert.deepEqual(
    (await call("imaging", "GET", "/api/department-tickets?department=IMG", undefined, IMAGING))
      .body.tickets,
    [],
  );
  const early = await call(
    "cashier",
    "GET",
    `/api/service-orders/${order.body.id}/voucher`,
    undefined,
    CASHIER,
  );
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, "payment_required");
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        "/api/department-tickets/00000000-0000-4000-8000-000000000000/start",
        undefined,
        LAB,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int as n from orders.department_tickets where order_id = $1",
        [order.body.id],
      )
    ).rows[0].n,
    0,
  );
  const before = await call(
    "doctor",
    "GET",
    `/api/service-orders/${order.body.id}/trace`,
    undefined,
    DOCTOR,
  );
  assert.deepEqual(
    before.body.steps.map((s: { step: string }) => s.step),
    ["placed"],
  );
  assert.equal(before.body.sentToDepartments, false);

  // 4. La caisse encaisse et valide.
  const paid = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "cash", receivedAmount: 10000 },
    CASHIER,
  );
  assert.equal(paid.status, 200, paid.raw);
  // Le ticket n'existe pas tant que l'événement de paiement n'a pas été traité.
  assert.equal(
    (
      await db.owner.query(
        "select count(*)::int as n from orders.department_tickets where order_id = $1",
        [order.body.id],
      )
    ).rows[0].n,
    0,
  );
  await t.dispatcher.drain();

  // 5. Un ticket est parti à chaque service concerné, et à lui seul.
  const labTickets = (
    await call("lab", "GET", "/api/department-tickets?department=LAB", undefined, LAB)
  ).body.tickets;
  const imgTickets = (
    await call("imaging", "GET", "/api/department-tickets?department=IMG", undefined, IMAGING)
  ).body.tickets;
  assert.equal(labTickets.length, 1);
  assert.equal(imgTickets.length, 1);
  assert.match(labTickets[0].code, /^T-LAB-\d{6}$/);
  assert.match(imgTickets[0].code, /^T-IMG-\d{6}$/);
  assert.equal(labTickets[0].patient.identifier, patient.identifier);
  assert.deepEqual(
    labTickets[0].items.map((i: { actCode: string }) => i.actCode),
    ["LAB-GLY", "LAB-NFS"],
  );
  assert.deepEqual(
    imgTickets[0].items.map((i: { actCode: string }) => i.actCode),
    ["IMG-RX"],
  );
  assert.equal(
    labTickets[0].releasedBy.id,
    CASHIER,
    "le ticket garde la trace de la caisse qui l'a libéré",
  );
  assert.equal(
    (await call("lab", "GET", "/api/department-tickets?department=IMG", undefined, LAB)).body.error
      .code,
    "wrong_department",
  );
  assert.equal(
    (await call("imaging", "GET", "/api/department-tickets?department=LAB", undefined, IMAGING))
      .status,
    403,
  );

  // 6. Le bon que la caisse remet au patient est maintenant disponible, avec les codes des tickets.
  const voucher = await call(
    "cashier",
    "GET",
    `/api/service-orders/${order.body.id}/voucher`,
    undefined,
    CASHIER,
  );
  assert.equal(voucher.status, 200, voucher.raw);
  assert.equal(voucher.body.receiptNumber, paid.body.payment.receiptNumber);
  assert.equal(voucher.body.validatedBy.id, CASHIER);
  assert.deepEqual(
    voucher.body.services.map((s: { departmentCode: string }) => s.departmentCode).sort(),
    ["IMG", "LAB"],
  );
  assert.match(voucher.body.services[0].ticket.payload, /^TK1\.T-[A-Z]+-\d{6}\.\d{2}$/);
  assert.equal(
    (await call("doctor", "GET", `/api/service-orders/${order.body.id}/voucher`, undefined, DOCTOR))
      .status,
    403,
  );
  assert.equal(
    (await call("reception", "GET", `/api/service-orders/${order.body.id}/voucher`)).status,
    403,
  );

  // 7. Chaque service active sa prestation, avec son propre ticket seulement.
  const labTicket = labTickets[0].id;
  const imgTicket = imgTickets[0].id;
  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/department-tickets/${labTicket}/start`,
        undefined,
        IMAGING,
      )
    ).body.error.code,
    "wrong_department",
  );
  assert.equal(
    (await call("lab", "POST", `/api/department-tickets/${labTicket}/complete`, undefined, LAB))
      .body.error.code,
    "not_started",
  );
  const started = await call(
    "lab",
    "POST",
    `/api/department-tickets/${labTicket}/start`,
    undefined,
    LAB,
  );
  assert.equal(started.status, 200, started.raw);
  assert.equal(started.body.status, "in_progress");
  assert.equal(started.body.startedBy.id, LAB);
  assert.equal(
    (await call("lab", "POST", `/api/department-tickets/${labTicket}/start`, undefined, LAB)).body
      .error.code,
    "already_started",
  );
  assert.equal(
    (await call("lab", "POST", `/api/department-tickets/${labTicket}/complete`, undefined, LAB))
      .status,
    200,
  );
  assert.equal(
    (await call("doctor", "GET", `/api/service-orders/${order.body.id}`, undefined, DOCTOR)).body
      .status,
    "released",
    "l'imagerie n'a pas fini",
  );
  await call("imaging", "POST", `/api/department-tickets/${imgTicket}/start`, undefined, IMAGING);
  await call(
    "imaging",
    "POST",
    `/api/department-tickets/${imgTicket}/complete`,
    undefined,
    IMAGING,
  );
  assert.equal(
    (await call("doctor", "GET", `/api/service-orders/${order.body.id}`, undefined, DOCTOR)).body
      .status,
    "completed",
  );

  // 8. Traçabilité : qui a demandé, qui a validé à la caisse, envoi au service, qui a exécuté.
  const trace = await call(
    "doctor",
    "GET",
    `/api/service-orders/${order.body.id}/trace`,
    undefined,
    DOCTOR,
  );
  assert.equal(trace.status, 200, trace.raw);
  const steps = trace.body.steps as { step: string; actor: { id: string; role: string } }[];
  assert.deepEqual(
    steps.map((s) => s.step),
    [
      "placed",
      "payment_validated",
      "sent_to_departments",
      "voucher_printed",
      "service_started",
      "service_completed",
      "service_started",
      "service_completed",
      "order_completed",
    ],
  );
  const by = (step: string, index = 0) => steps.filter((s) => s.step === step)[index]?.actor;
  assert.equal(by("placed")?.id, DOCTOR, "qui a demandé");
  assert.equal(by("payment_validated")?.id, CASHIER, "qui a validé à la caisse");
  assert.equal(by("payment_validated")?.role, "cashier");
  assert.match(by("sent_to_departments")?.id ?? "", /^system:orders\.release-on-payment$/);
  assert.equal(by("voucher_printed")?.id, CASHIER);
  assert.equal(by("service_started", 0)?.id, LAB);
  assert.equal(by("service_started", 1)?.id, IMAGING);
  assert.equal(trace.body.sentToDepartments, true);
  assert.equal(trace.body.invoice.status, "paid");
  assert.equal(trace.body.invoice.cashier.id, CASHIER);
  assert.equal(trace.body.invoice.receiptNumber, paid.body.payment.receiptNumber);
  const sent = (
    trace.body.steps as { step: string; detail: { tickets: { code: string }[] } }[]
  ).find((s) => s.step === "sent_to_departments");
  assert.equal(sent?.detail.tickets.length, 2);

  // 9. Événements : la libération porte le nom de la caisse ; l'audit garde le lien avec l'événement.
  const released = await db.owner.query(
    "select payload from events.outbox where type = 'ServiceOrderReleased' and patient_id = $1",
    [patient.id],
  );
  assert.equal(released.rows[0].payload.releasedBy.userId, CASHIER);
  assert.equal(released.rows[0].payload.tickets.length, 2);
  const audit = await db.owner.query(
    "select actor_id, request_id from audit.log where action = 'order.release' and patient_id = $1",
    [patient.id],
  );
  assert.equal(audit.rows[0].actor_id, "system:orders.release-on-payment");
  const paidEvent = await db.owner.query(
    "select event_id from events.outbox where type = 'InvoicePaid' and patient_id = $1 and payload->>'orderId' = $2",
    [patient.id, order.body.id],
  );
  assert.equal(
    audit.rows[0].request_id,
    paidEvent.rows[0].event_id,
    "numéro de corrélation = événement de paiement",
  );
});

test("un ticket ne peut pas être créé sans la validation de la caisse, même par une erreur de code", async () => {
  const { patient, encounterId } = await consultedPatient();
  const order = await place(patient.id, encounterId, [{ actCode: "LAB-GLY", quantity: 1 }]);
  await t.dispatcher.drain();
  await assert.rejects(
    () =>
      db.app.query(
        "insert into orders.department_tickets (order_id, code, department_code, released_by) values ($1, 'T-LAB-999999', 'LAB', 'quelqu-un')",
        [order.body.id],
      ),
    /Aucun ticket sans validation de la caisse/,
  );
  await assert.rejects(
    () => db.owner.query("update orders.order_events set step = 'x'"),
    /ajout seul/,
  );
});

test("rejouer l'événement de paiement ne crée aucun ticket en double", async () => {
  const { patient, encounterId } = await consultedPatient();
  const order = await place(patient.id, encounterId, [
    { actCode: "LAB-GLY", quantity: 1 },
    { actCode: "IMG-RX", quantity: 1 },
  ]);
  await t.dispatcher.drain();
  const invoice = await pendingInvoiceOf(order.body.number);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "cash" },
    CASHIER,
  );
  await t.dispatcher.drain();
  const count = () =>
    db.owner
      .query("select count(*)::int as n from orders.department_tickets where order_id = $1", [
        order.body.id,
      ])
      .then((r) => r.rows[0].n);
  assert.equal(await count(), 2);
  await db.owner.query("delete from events.processed where consumer = 'orders.release-on-payment'");
  await db.owner.query(
    "update events.consumer_cursor set last_id = 0 where consumer = 'orders.release-on-payment'",
  );
  await t.dispatcher.drain();
  assert.equal(await count(), 2);
  const steps = await db.owner.query(
    "select count(*)::int as n from orders.order_events where order_id = $1 and step = 'sent_to_departments'",
    [order.body.id],
  );
  assert.equal(steps.rows[0].n, 1);
});

test("prise en charge totale par l'assurance ou gratuité : la caisse valide quand même (exempt)", async () => {
  const { patient, encounterId } = await consultedPatient("GRATUIT");
  const order = await place(patient.id, encounterId, [{ actCode: "IMG-RX", quantity: 1 }]);
  await t.dispatcher.drain();
  const invoice = await pendingInvoiceOf(order.body.number);
  assert.equal(invoice.patientAmount, 0);
  assert.equal(
    (
      await call("lab", "GET", "/api/department-tickets?department=LAB", undefined, LAB)
    ).body.tickets.filter((x: { orderNumber: string }) => x.orderNumber === order.body.number)
      .length,
    0,
  );
  assert.equal(
    (
      await call("imaging", "GET", "/api/department-tickets?department=IMG", undefined, IMAGING)
    ).body.tickets.filter((x: { orderNumber: string }) => x.orderNumber === order.body.number)
      .length,
    0,
    "pas de ticket tant que la caisse n'a pas validé",
  );
  const pay = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "exempt" },
    CASHIER,
  );
  assert.equal(pay.status, 200, pay.raw);
  await t.dispatcher.drain();
  const tickets = (
    await call("imaging", "GET", "/api/department-tickets?department=IMG", undefined, IMAGING)
  ).body.tickets;
  assert.equal(
    tickets.filter((x: { orderNumber: string }) => x.orderNumber === order.body.number).length,
    1,
  );
});

test("assurance partielle : le ticket part quand la part du patient est payée", async () => {
  const { patient, encounterId } = await consultedPatient("ASSUR");
  const order = await place(patient.id, encounterId, [{ actCode: "HOSP-1J", quantity: 3 }]);
  await t.dispatcher.drain();
  const invoice = await pendingInvoiceOf(order.body.number);
  assert.equal(invoice.total, 30000);
  assert.equal(invoice.patientAmount, 6000);
  assert.equal(invoice.payerAmount, 24000);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "mobile" },
    CASHIER,
  );
  await t.dispatcher.drain();
  const nurse = await call("nurse", "GET", "/api/department-tickets?department=HOSP");
  assert.equal(
    nurse.body.tickets.filter((x: { orderNumber: string }) => x.orderNumber === order.body.number)
      .length,
    1,
  );
});

test("droits : qui peut demander, qui peut encaisser, qui peut lire", async () => {
  const { patient, encounterId } = await consultedPatient();
  const body = { patientId: patient.id, encounterId, items: [{ actCode: "LAB-GLY", quantity: 1 }] };
  for (const role of [
    "cashier",
    "reception",
    "lab",
    "biologist",
    "imaging",
    "pharmacy",
    "direction",
    "admin",
  ] as const) {
    assert.equal(
      (await call(role, "POST", "/api/service-orders", body)).status,
      403,
      `${role} ne demande pas de prestations`,
    );
  }
  assert.equal((await call("nurse", "POST", "/api/service-orders", body)).status, 201);
  const order = await place(patient.id, encounterId, [{ actCode: "LAB-GLY", quantity: 1 }]);
  await t.dispatcher.drain();
  const invoice = await pendingInvoiceOf(order.body.number);
  for (const role of [
    "doctor",
    "nurse",
    "reception",
    "lab",
    "imaging",
    "admin",
    "direction",
  ] as const) {
    assert.equal(
      (await call(role, "POST", `/api/billing/invoices/${invoice.id}/pay`, { method: "cash" }))
        .status,
      403,
      `${role} n'encaisse pas`,
    );
  }
  for (const role of ["reception", "lab", "imaging", "pharmacy", "direction"] as const) {
    assert.equal(
      (await call(role, "GET", `/api/service-orders/${order.body.id}/trace`)).status,
      403,
      `${role} ne lit pas la trace`,
    );
  }
  for (const role of ["doctor", "cashier", "admin"] as const) {
    assert.equal(
      (await call(role, "GET", `/api/service-orders/${order.body.id}/trace`)).status,
      200,
      `${role} lit la trace`,
    );
  }
  for (const role of ["doctor", "reception", "cashier", "pharmacy", "direction"] as const) {
    assert.equal(
      (await call(role, "GET", "/api/department-tickets?department=LAB")).status,
      403,
      `${role} n'a pas de tickets de service`,
    );
  }
});

test("demande invalide : acte de consultation, acte inconnu, admission d'un autre patient ou clôturée", async () => {
  const { patient, encounterId } = await consultedPatient();
  const other = await newPatient(call);
  assert.equal(
    (await place(patient.id, encounterId, [{ actCode: "CONS-SPE", quantity: 1 }])).body.error.code,
    "act_not_orderable",
  );
  assert.equal(
    (await place(patient.id, encounterId, [{ actCode: "INCONNU", quantity: 1 }])).status,
    404,
  );
  assert.equal((await place(patient.id, encounterId, [])).status, 400);
  assert.equal(
    (await place(other.id, encounterId, [{ actCode: "LAB-GLY", quantity: 1 }])).body.error.code,
    "encounter_mismatch",
  );
  await db.owner.query("update billing.encounters set status = 'closed' where id = $1", [
    encounterId,
  ]);
  assert.equal(
    (await place(patient.id, encounterId, [{ actCode: "LAB-GLY", quantity: 1 }])).body.error.code,
    "encounter_closed",
  );
  const { patient: p2, encounterId: e2 } = await consultedPatient();
  const merged = await place(p2.id, e2, [
    { actCode: "LAB-GLY", quantity: 2 },
    { actCode: "LAB-GLY", quantity: 1 },
  ]);
  assert.equal(merged.body.items.length, 1, "actes identiques regroupés");
  assert.equal(merged.body.items[0].quantity, 3);
});

test("un avoir avant paiement annule la demande : plus de ticket, plus de bon", async () => {
  const { patient, encounterId } = await consultedPatient();
  const order = await place(patient.id, encounterId, [{ actCode: "LAB-GLY", quantity: 1 }]);
  await t.dispatcher.drain();
  const invoice = await pendingInvoiceOf(order.body.number);
  const credit = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/credit-note`,
    { reason: "demande annulée par le médecin" },
    CASHIER,
  );
  assert.equal(credit.status, 201, credit.raw);
  await t.dispatcher.drain();
  assert.equal(
    (await call("doctor", "GET", `/api/service-orders/${order.body.id}`, undefined, DOCTOR)).body
      .status,
    "cancelled",
  );
  assert.equal(
    (
      await call(
        "cashier",
        "GET",
        `/api/service-orders/${order.body.id}/voucher`,
        undefined,
        CASHIER,
      )
    ).body.error.code,
    "order_cancelled",
  );
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/invoices/${invoice.id}/pay`,
        { method: "cash" },
        CASHIER,
      )
    ).body.error.code,
    "credited",
  );
  const trace = (
    await call("doctor", "GET", `/api/service-orders/${order.body.id}/trace`, undefined, DOCTOR)
  ).body.steps.map((s: { step: string }) => s.step);
  assert.deepEqual(trace, ["placed", "cancelled_by_credit_note"]);
});

test("un avoir après paiement mais avant le service annule les tickets ; après le début du service, la demande est conservée et signalée", async () => {
  const first = await consultedPatient();
  const o1 = await place(first.patient.id, first.encounterId, [{ actCode: "IMG-RX", quantity: 1 }]);
  await t.dispatcher.drain();
  const inv1 = await pendingInvoiceOf(o1.body.number);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv1.id}/pay`,
    { method: "cash" },
    CASHIER,
  );
  await t.dispatcher.drain();
  const ticket1 = (
    await call(
      "imaging",
      "GET",
      "/api/department-tickets?department=IMG&status=sent",
      undefined,
      IMAGING,
    )
  ).body.tickets.find((x: { orderNumber: string }) => x.orderNumber === o1.body.number);
  assert.ok(ticket1);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv1.id}/credit-note`,
    { reason: "erreur" },
    CASHIER,
  );
  await t.dispatcher.drain();
  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/department-tickets/${ticket1.id}/start`,
        undefined,
        IMAGING,
      )
    ).body.error.code,
    "ticket_cancelled",
  );

  const second = await consultedPatient();
  const o2 = await place(second.patient.id, second.encounterId, [
    { actCode: "IMG-RX", quantity: 1 },
  ]);
  await t.dispatcher.drain();
  const inv2 = await pendingInvoiceOf(o2.body.number);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv2.id}/pay`,
    { method: "cash" },
    CASHIER,
  );
  await t.dispatcher.drain();
  const ticket2 = (
    await call(
      "imaging",
      "GET",
      "/api/department-tickets?department=IMG&status=sent",
      undefined,
      IMAGING,
    )
  ).body.tickets.find((x: { orderNumber: string }) => x.orderNumber === o2.body.number);
  await call("imaging", "POST", `/api/department-tickets/${ticket2.id}/start`, undefined, IMAGING);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv2.id}/credit-note`,
    { reason: "litige" },
    CASHIER,
  );
  await t.dispatcher.drain();
  const order2 = await call(
    "doctor",
    "GET",
    `/api/service-orders/${o2.body.id}`,
    undefined,
    DOCTOR,
  );
  assert.equal(
    order2.body.status,
    "released",
    "la prestation a commencé : la demande n'est pas annulée",
  );
  const steps = (
    await call("doctor", "GET", `/api/service-orders/${o2.body.id}/trace`, undefined, DOCTOR)
  ).body.steps.map((s: { step: string }) => s.step);
  assert.ok(steps.includes("credit_note_after_service_started"));
});

test("les consommateurs de la règle de la caisse sont indépendants : la caisse reste utilisable si la facturation est en retard", async () => {
  const { patient, encounterId } = await consultedPatient();
  const order = await place(patient.id, encounterId, [{ actCode: "LAB-GLY", quantity: 1 }]);
  // Le distributeur n'a pas tourné : la demande existe, la facture n'est pas encore émise.
  assert.equal(
    (
      await call(
        "cashier",
        "GET",
        `/api/billing/invoices?status=pending&orderNumber=${order.body.number}`,
        undefined,
        CASHIER,
      )
    ).body.invoices.length,
    0,
  );
  assert.equal(
    (await call("doctor", "GET", `/api/service-orders/${order.body.id}`, undefined, DOCTOR)).body
      .status,
    "awaiting_payment",
  );
  await t.dispatcher.drain();
  assert.equal((await pendingInvoiceOf(order.body.number)).orderNumber, order.body.number);
});
