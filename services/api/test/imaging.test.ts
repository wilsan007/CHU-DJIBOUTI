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

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const DR = "dr-img";
const CASHIER = "caissier-img";
const TECH = "tech-radio";
const RAD = "radiologue-1";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);

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

async function released(items = [{ actCode: "IMG-RX", quantity: 1 }]) {
  const patient = await newPatient(call, "Radio");
  const adm = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    { patientId: patient.id, encounterId: adm.encounter.id, items },
    DR,
  );
  assert.equal(order.status, 201, order.raw);
  await t.dispatcher.drain();
  const early = await call(
    "imaging",
    "GET",
    `/api/imaging/requests?patientId=${patient.id}`,
    undefined,
    TECH,
  );
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
        { method: "cash", receivedAmount: 100000 },
        CASHIER,
      )
    ).status,
    200,
  );
  await t.dispatcher.drain();
  const list = await call(
    "imaging",
    "GET",
    `/api/imaging/requests?patientId=${patient.id}`,
    undefined,
    TECH,
  );
  return {
    patient,
    orderId: order.body.id as string,
    before: early.body.requests.length as number,
    requests: list.body.requests as { id: string; number: string; status: string }[],
  };
}

test("F8 : l'examen n'existe qu'après le paiement ; programmation, début, images, compte rendu, ticket terminé", async () => {
  const r = await released([{ actCode: "IMG-RX", quantity: 2 }]);
  assert.equal(r.before, 0, "rien avant le paiement");
  assert.equal(r.requests.length, 2, "un examen par acte demandé");
  assert.match(r.requests[0]?.number ?? "", /^X-\d{6}$/);
  const [a, b] = r.requests as unknown as [{ id: string }, { id: string }];
  assert.equal(
    (await call("doctor", "POST", `/api/imaging/requests/${a.id}/perform`, {}, DR)).status,
    403,
  );

  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/schedule`,
        { scheduledFor: "2020-01-01T08:00:00+03:00" },
        TECH,
      )
    ).body.error.code,
    "past_date",
  );
  const when = new Date(Date.now() + 86_400_000).toISOString();
  const sch = await call(
    "imaging",
    "POST",
    `/api/imaging/requests/${a.id}/schedule`,
    { scheduledFor: when },
    TECH,
  );
  assert.equal(sch.body.status, "scheduled");

  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/images`,
        { filename: "a.png", mime: "image/png", dataBase64: PNG.toString("base64") },
        TECH,
      )
    ).body.error.code,
    "not_in_progress",
  );
  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/report`,
        { findings: "xxx", conclusion: "yyy" },
        RAD,
      )
    ).body.error.code,
    "not_performed",
  );
  const perf = await call("imaging", "POST", `/api/imaging/requests/${a.id}/perform`, {}, TECH);
  assert.equal(perf.status, 200, perf.raw);
  assert.match(perf.body.accession, /^ACC-\d{8}$/);
  const tk = await db.owner.query(
    "select status, started_by from orders.department_tickets where order_id = $1 and department_code = 'IMG'",
    [r.orderId],
  );
  assert.deepEqual([tk.rows[0].status, tk.rows[0].started_by], ["in_progress", TECH]);
  assert.equal(
    (await call("imaging", "POST", `/api/imaging/requests/${a.id}/perform`, {}, TECH)).body.error
      .code,
    "already_performed",
  );

  // Images : le type est vérifié sur le contenu.
  const png = { filename: "thorax.png", mime: "image/png", dataBase64: PNG.toString("base64") };
  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/images`,
        { ...png, mime: "image/jpeg" },
        TECH,
      )
    ).body.error.code,
    "mime_mismatch",
  );
  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/images`,
        { ...png, mime: "application/dicom" },
        TECH,
      )
    ).status,
    415,
  );
  const img = await call("imaging", "POST", `/api/imaging/requests/${a.id}/images`, png, TECH);
  assert.equal(img.status, 201, img.raw);

  // Avant le compte rendu, le médecin ne voit ni le compte rendu ni les images.
  const pre = await call("doctor", "GET", `/api/imaging/requests/${a.id}`, undefined, DR);
  assert.deepEqual([pre.body.reports, pre.body.images], [[], []]);
  assert.equal(
    (await call("doctor", "GET", `/api/imaging/images/${img.body.id}`, undefined, DR)).status,
    403,
  );

  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/report`,
        { findings: "Poumons clairs.", conclusion: "Pas d'anomalie visible (exemple de test)." },
        RAD,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await db.owner.query(
        "select status from orders.department_tickets where order_id = $1 and department_code = 'IMG'",
        [r.orderId],
      )
    ).rows[0].status,
    "in_progress",
    "l'autre examen du ticket reste à faire",
  );
  await call("imaging", "POST", `/api/imaging/requests/${b.id}/perform`, {}, TECH);
  await call(
    "imaging",
    "POST",
    `/api/imaging/requests/${b.id}/report`,
    { findings: "Fracture non déplacée.", conclusion: "Fracture du radius (exemple de test)." },
    RAD,
  );
  const done = await db.owner.query(
    "select status, completed_by from orders.department_tickets where order_id = $1 and department_code = 'IMG'",
    [r.orderId],
  );
  assert.deepEqual([done.rows[0].status, done.rows[0].completed_by], ["completed", RAD]);

  const doc = await call("doctor", "GET", `/api/imaging/requests/${a.id}`, undefined, DR);
  assert.equal(doc.body.reports[0].conclusion, "Pas d'anomalie visible (exemple de test).");
  assert.equal(doc.body.images.length, 1);
  const file = await t.app.inject({
    method: "GET",
    url: `/api/imaging/images/${img.body.id}`,
    headers: await t.as("doctor"),
  });
  assert.equal(file.statusCode, 200);
  assert.ok(file.rawPayload.equals(PNG), "image identique à l'envoi");
  assert.ok(
    (await db.owner.query("select 1 from audit.log where action = 'imaging.image.read'"))
      .rowCount === 1,
  );

  // Correction : nouvelle version, l'ancienne reste.
  assert.equal(
    (
      await call(
        "imaging",
        "POST",
        `/api/imaging/requests/${a.id}/report`,
        { findings: "Poumons clairs, cœur normal.", conclusion: "Normal (exemple de test)." },
        RAD,
      )
    ).body.version,
    2,
  );
  const again = await call("doctor", "GET", `/api/imaging/requests/${a.id}`, undefined, DR);
  assert.deepEqual(
    again.body.reports.map((x: { version: number }) => x.version),
    [2, 1],
  );
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'ImagingReportFinalized'",
  );
  assert.equal(ev.rowCount, 2, "un événement par examen, pas pour les corrections");
  assert.equal(ev.rows.find((e) => e.payload.requestId === a.id).payload.imageCount, 1);
  await assert.rejects(
    db.owner.query("update imaging.reports set conclusion = 'x'"),
    /ne se modifie ni ne se supprime/,
  );
  await assert.rejects(
    db.owner.query("delete from imaging.images"),
    /ne se modifie ni ne se supprime/,
  );
});

test("F8 : la caisse, le laboratoire et la réception n'ont pas accès à l'imagerie", async () => {
  for (const role of ["cashier", "lab", "reception", "direction", "pharmacy"] as const)
    assert.equal((await call(role, "GET", "/api/imaging/requests")).status, 403, role);
});
