import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cardPayload } from "../src/modules/identity/card.ts";
import { escalateOverdue, specimenPayload } from "../src/modules/lab/service.ts";
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

/** Valeurs de référence FICTIVES, pour les tests seulement (à fournir par le biologiste en production). */
const TESTS_CSV = `code,loinc,act_code,libelle_fr,libelle_ar,echantillon,unite,type_valeur,responsable,date_maj
GLY,2345-7,LAB-GLY,Glycémie,سكر الدم,Sérum,mmol/L,numeric,Biologiste test,2026-11-01
`;
const NFS_CSV = `${TESTS_CSV}HB,718-7,LAB-NFS,Hémoglobine,هيموغلوبين,Sérum,g/dL,numeric,Biologiste test,2026-11-01
`;

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const DR = "dr-labo";
const CASHIER = "caissier-labo";
const TECH = "tech-1";
const BIO = "bio-1";

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  await openCash(call, CASHIER);
  const imp = await call("biologist", "POST", "/api/lab/tests/import", TESTS_CSV, BIO);
  assert.equal(imp.status, 200, imp.raw);
  assert.equal(imp.body.imported, 1, imp.raw);
});
after(async () => {
  await t.close();
  await db.drop();
});

/** Parcours complet jusqu'à la demande du laboratoire : demande du médecin, paiement à la caisse, ticket. */
async function labRequest(items: { actCode: string; quantity: number }[], doctor = DR) {
  const patient = await newPatient(call, "Labo");
  const admission = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    { patientId: patient.id, encounterId: admission.encounter.id, items },
    doctor,
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
  const paid = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  assert.equal(paid.status, 200, paid.raw);
  await t.dispatcher.drain();
  const list = await call(
    "lab",
    "GET",
    `/api/lab/requests?patientId=${patient.id}`,
    undefined,
    TECH,
  );
  return {
    patient,
    orderId: order.body.id as string,
    request: list.body.requests[0] as {
      id: string;
      number: string;
      ticketCode: string;
      tests: { testCode: string | null }[];
    },
  };
}

async function collected(items = [{ actCode: "LAB-GLY", quantity: 1 }]) {
  const r = await labRequest(items);
  const sp = await call(
    "lab",
    "POST",
    `/api/lab/requests/${r.request.id}/collect`,
    { patientScan: cardPayload(r.patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  assert.equal(sp.status, 201, sp.raw);
  return { ...r, specimen: sp.body as { id: string; number: string; payload: string } };
}
async function received(items?: { actCode: string; quantity: number }[]) {
  const c = await collected(items);
  const rc = await call(
    "lab",
    "POST",
    "/api/lab/specimens/receive",
    { scan: c.specimen.payload },
    TECH,
  );
  assert.equal(rc.status, 200, rc.raw);
  return c;
}

async function setGlyRanges() {
  const res = await call(
    "biologist",
    "PUT",
    "/api/lab/tests/GLY/ranges",
    {
      ranges: [
        {
          sex: "any",
          ageMinDays: 6570,
          ageMaxDays: 32850,
          criticalLow: 2.2,
          low: 3.9,
          high: 6.1,
          criticalHigh: 25,
        },
      ],
      validatedBy: "Biologiste test",
      validatedOn: "2026-11-01",
    },
    BIO,
  );
  assert.equal(res.status, 200, res.raw);
}

test("F7-1 : la demande du laboratoire n'existe qu'après le paiement ; événement avec les codes LOINC", async () => {
  const patient = await newPatient(call, "Avant");
  const admission = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    {
      patientId: patient.id,
      encounterId: admission.encounter.id,
      items: [{ actCode: "LAB-GLY", quantity: 1 }],
    },
    DR,
  );
  await t.dispatcher.drain();
  assert.equal(
    (await call("lab", "GET", `/api/lab/requests?patientId=${patient.id}`, undefined, TECH)).body
      .requests.length,
    0,
    "rien avant le paiement",
  );

  const r = await labRequest([{ actCode: "LAB-GLY", quantity: 1 }]);
  assert.match(r.request.number, /^R-\d{6}$/);
  assert.equal(r.request.tests.length, 1);
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'LabOrderCreated' and payload->>'orderId' = $1",
    [r.orderId],
  );
  assert.equal(ev.rowCount, 1);
  assert.deepEqual(ev.rows[0].payload.loincCodes, ["2345-7"]);
  void order;
  assert.equal(
    (await call("doctor", "GET", "/api/lab/requests")).status,
    403,
    "le médecin passe par les résultats, pas par la file du laboratoire",
  );
  assert.equal((await call("cashier", "GET", "/api/lab/tests")).status, 403);

  // Acte sans analyse configurée : visible, mais impossible à prélever.
  const un = await labRequest([{ actCode: "LAB-NFS", quantity: 1 }]);
  assert.equal(un.request.tests[0]?.testCode, null);
  const nope = await call(
    "lab",
    "POST",
    `/api/lab/requests/${un.request.id}/collect`,
    { patientScan: cardPayload(un.patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  assert.equal(nope.body.error.code, "nothing_to_collect");
  const bad = await call("biologist", "POST", "/api/lab/tests/import", "code,loinc\nX,1-1\n", BIO);
  assert.equal(bad.status, 400);
  const bad2 = await call(
    "biologist",
    "POST",
    "/api/lab/tests/import",
    `${TESTS_CSV.split("\n")[0]}\nZ,pas-loinc,LAB-INCONNU,a,b,Sérum,,numeric,x,2026-11-01\n`,
    BIO,
  );
  assert.equal(bad2.body.rejected.length, 1);
  const full = await call("biologist", "POST", "/api/lab/tests/import", NFS_CSV, BIO);
  assert.equal(full.body.imported, 2, full.raw);
});

test("F7-2 : le prélèvement exige la carte du bon patient ; étiquette ; le ticket démarre", async () => {
  const r = await labRequest([{ actCode: "LAB-GLY", quantity: 1 }]);
  const other = await newPatient(call, "Autre");
  const wrong = await call(
    "lab",
    "POST",
    `/api/lab/requests/${r.request.id}/collect`,
    { patientScan: cardPayload(other.identifier), specimenType: "Sérum" },
    TECH,
  );
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error.code, "identity_mismatch");
  const garbage = await call(
    "lab",
    "POST",
    `/api/lab/requests/${r.request.id}/collect`,
    { patientScan: "CHU1.XXX.00", specimenType: "Sérum" },
    TECH,
  );
  assert.equal(garbage.body.error.code, "identity_mismatch");
  assert.equal(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'lab.identity-refused' and entity_id = $1",
        [r.request.id],
      )
    ).rowCount,
    2,
    "refus tracés",
  );
  assert.equal(
    (
      await db.owner.query("select count(*)::int n from lab.specimens where request_id = $1", [
        r.request.id,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.owner.query("select status from orders.department_tickets where code = $1", [
        r.request.ticketCode,
      ])
    ).rows[0].status,
    "sent",
    "refus : le ticket n'a pas démarré",
  );

  const ok = await call(
    "lab",
    "POST",
    `/api/lab/requests/${r.request.id}/collect`,
    { patientScan: cardPayload(r.patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  assert.equal(ok.status, 201, ok.raw);
  assert.match(ok.body.number, /^S-\d{6}$/);
  assert.equal(ok.body.payload, specimenPayload(ok.body.number));
  const tk = await db.owner.query(
    "select status, started_by from orders.department_tickets where code = $1",
    [r.request.ticketCode],
  );
  assert.deepEqual([tk.rows[0].status, tk.rows[0].started_by], ["in_progress", TECH]);
  const label = await call("lab", "GET", `/api/lab/specimens/${ok.body.id}/label`, undefined, TECH);
  assert.ok(label.body.html.includes(ok.body.payload) && label.body.html.includes("Labo"));
  const again = await call(
    "lab",
    "POST",
    `/api/lab/requests/${r.request.id}/collect`,
    { patientScan: cardPayload(r.patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  assert.equal(again.body.error.code, "nothing_to_collect");
  assert.equal(
    (await call("doctor", "POST", `/api/lab/requests/${r.request.id}/collect`, {}, DR)).status,
    403,
  );
});

test("F7-3 : réception par scan, rejet avec motif, notification au prescripteur, nouveau prélèvement", async () => {
  const c = await collected();
  const tampered = c.specimen.payload.replace(/\d{2}$/, (d) =>
    String((Number(d) + 1) % 100).padStart(2, "0"),
  );
  assert.equal(
    (await call("lab", "POST", "/api/lab/specimens/receive", { scan: tampered }, TECH)).status,
    400,
  );
  assert.equal(
    (await call("lab", "POST", "/api/lab/specimens/receive", { scan: c.specimen.payload }, TECH))
      .status,
    200,
  );
  assert.equal(
    (await call("lab", "POST", "/api/lab/specimens/receive", { scan: c.specimen.payload }, TECH))
      .body.error.code,
    "already_received",
  );

  const d = await collected();
  assert.equal(
    (await call("lab", "POST", `/api/lab/specimens/${d.specimen.id}/reject`, { reason: "x" }, TECH))
      .status,
    400,
  );
  const rej = await call(
    "lab",
    "POST",
    `/api/lab/specimens/${d.specimen.id}/reject`,
    { reason: "Échantillon hémolysé" },
    TECH,
  );
  assert.equal(rej.status, 200, rej.raw);
  const notes = await call("doctor", "GET", "/api/lab/notifications?open=true", undefined, DR);
  const rejection = notes.body.notifications.find(
    (n: { kind: string; requestId: string }) =>
      n.kind === "rejection" && n.requestId === d.request.id,
  );
  assert.ok(rejection?.message.includes("hémolysé"));
  assert.equal(
    (await call("doctor", "GET", "/api/lab/notifications", undefined, "autre-medecin")).body
      .notifications.length,
    0,
    "chacun ne voit que les siennes",
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/lab/notifications/${rejection.id}/acknowledge`,
        {},
        "autre-medecin",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("doctor", "POST", `/api/lab/notifications/${rejection.id}/acknowledge`, {}, DR))
      .status,
    200,
  );
  assert.equal(
    (
      await db.owner.query(
        "select 1 from events.outbox where type = 'LabSpecimenRejected' and payload->>'specimenId' = $1",
        [d.specimen.id],
      )
    ).rowCount,
    1,
  );
  const again = await call(
    "lab",
    "POST",
    `/api/lab/requests/${d.request.id}/collect`,
    { patientScan: cardPayload(d.patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  assert.equal(again.status, 201, "nouveau prélèvement possible");
  assert.notEqual(again.body.number, d.specimen.number);
});

test("F7-4 : drapeaux selon les valeurs de référence du biologiste ; valeur critique notifiée, accusé, escalade", async () => {
  const noRange = await received();
  const none = await call(
    "lab",
    "POST",
    `/api/lab/specimens/${noRange.specimen.id}/results`,
    { testCode: "GLY", value: 5 },
    TECH,
  );
  assert.equal(none.body.flag, "none", "sans plage fournie, aucun drapeau inventé");

  await setGlyRanges();
  const unreceived = await collected();
  const early = await call(
    "lab",
    "POST",
    `/api/lab/specimens/${unreceived.specimen.id}/results`,
    { testCode: "GLY", value: 5 },
    TECH,
  );
  assert.equal(early.body.error.code, "specimen_not_received");

  const flags: Record<number, string> = {
    5: "normal",
    3: "low",
    7: "high",
    1.5: "critical_low",
    30: "critical_high",
  };
  for (const [value, flag] of Object.entries(flags)) {
    const c = await received();
    const res = await call(
      "lab",
      "POST",
      `/api/lab/specimens/${c.specimen.id}/results`,
      { testCode: "GLY", value: Number(value) },
      TECH,
    );
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.flag, flag, `valeur ${value}`);
  }
  const text = await received();
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        `/api/lab/specimens/${text.specimen.id}/results`,
        { testCode: "GLY", text: "positif" },
        TECH,
      )
    ).body.error.code,
    "numeric_required",
  );
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        `/api/lab/specimens/${text.specimen.id}/results`,
        { testCode: "HB", value: 12 },
        TECH,
      )
    ).body.error.code,
    "test_not_on_specimen",
  );
  // Correction avant validation.
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        `/api/lab/specimens/${text.specimen.id}/results`,
        { testCode: "GLY", value: 5 },
        TECH,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        `/api/lab/specimens/${text.specimen.id}/results`,
        { testCode: "GLY", value: 5.5 },
        TECH,
      )
    ).status,
    201,
  );
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'lab.result.correct'")).rowCount,
    1,
  );

  // Valeurs critiques : une notification par résultat, chez le prescripteur.
  const crit = await call("doctor", "GET", "/api/lab/notifications?open=true", undefined, DR);
  const criticals = crit.body.notifications.filter((n: { kind: string }) => n.kind === "critical");
  assert.equal(criticals.length, 2);
  assert.ok(criticals[0].message.includes("Accusé"));
  assert.equal(
    (await call("doctor", "POST", `/api/lab/notifications/${criticals[0].id}/acknowledge`, {}, DR))
      .status,
    200,
  );

  // Escalade : délai et destinataire fixés par le biologiste ; seul le non-acquitté monte.
  assert.equal(
    (await call("lab", "PUT", "/api/lab/settings", { criticalAckMinutes: 10 }, TECH)).status,
    403,
  );
  const set = await call(
    "biologist",
    "PUT",
    "/api/lab/settings",
    { criticalAckMinutes: 10, escalationUser: "chef-labo" },
    BIO,
  );
  assert.equal(set.status, 200, set.raw);
  assert.equal(await escalateOverdue(db.app, new Date(Date.now() + 5 * 60_000)), 0, "trop tôt");
  assert.equal(await escalateOverdue(db.app, new Date(Date.now() + 15 * 60_000)), 1);
  assert.equal(
    await escalateOverdue(db.app, new Date(Date.now() + 20 * 60_000)),
    0,
    "une seule escalade",
  );
  const chef = await call("doctor", "GET", "/api/lab/notifications", undefined, "chef-labo");
  assert.equal(chef.body.notifications.length, 1);
  assert.equal(chef.body.notifications[0].kind, "escalation");
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'lab.escalate'")).rowCount,
    1,
  );
});

test("F7-5 : analyseur simulé ; un résultat n'atteint jamais le mauvais échantillon", async () => {
  await setGlyRanges();
  const map = await call(
    "biologist",
    "PUT",
    "/api/lab/analyzers/SIM1/mappings",
    { mappings: [{ analyzerCode: "GLU", testCode: "GLY" }] },
    BIO,
  );
  assert.equal(map.status, 200, map.raw);
  const a = await received();
  const b = await collected(); // non reçu
  const msg = (payload: string, ...lines: string[]) =>
    ["H|SIM1", `O|${payload}`, ...lines].join("\n");
  const send = (message: string, analyzer = "SIM1") =>
    call("lab", "POST", `/api/lab/analyzers/${analyzer}/messages`, { message }, TECH);

  const ok = await send(msg(a.specimen.payload, "R|GLU|5.2|mmol/L"));
  assert.equal(ok.status, 200, ok.raw);
  assert.deepEqual(ok.body.accepted, [{ testCode: "GLY", flag: "normal" }]);
  const stored = await db.owner.query(
    "select source, specimen_id from lab.results where specimen_id = $1",
    [a.specimen.id],
  );
  assert.equal(stored.rows[0].source, "analyzer:SIM1");
  assert.equal(stored.rows[0].specimen_id, a.specimen.id);

  const before = (await db.owner.query("select count(*)::int n from lab.results")).rows[0].n;
  const tampered = a.specimen.payload.replace(/\d{2}$/, (d) =>
    String((Number(d) + 1) % 100).padStart(2, "0"),
  );
  assert.equal((await send(msg(tampered, "R|GLU|9"))).body.error.code, "invalid_scan");
  assert.equal(
    (await send(msg(specimenPayload("S-999999"), "R|GLU|9"))).body.error.code,
    "unknown_specimen",
  );
  const notReceived = await send(msg(b.specimen.payload, "R|GLU|9"));
  assert.equal(notReceived.body.rejected.length, 1);
  assert.equal(notReceived.body.accepted.length, 0);
  const mixed = await send(msg(a.specimen.payload, "R|XXX|1", "R|GLU|abc"));
  assert.deepEqual(
    mixed.body.rejected.map((r: { code: string }) => r.code),
    ["XXX", "GLU"],
  );
  assert.equal(
    (await send("H|SIM1\nO|a\nO|b\nR|GLU|1")).body.error.code,
    "bad_message",
    "deux échantillons dans un message : refusé",
  );
  assert.equal(
    (await send(msg(a.specimen.payload, "R|GLU|5"), "AUTRE")).body.error.code,
    "analyzer_mismatch",
  );
  assert.equal(
    (await db.owner.query("select count(*)::int n from lab.results")).rows[0].n,
    before,
    "rien d'enregistré en trop",
  );
});

test("F7-6 : validation en deux temps par deux personnes ; le médecin ne voit que le validé ; ticket terminé", async () => {
  await setGlyRanges();
  const c = await received();
  await call(
    "lab",
    "POST",
    `/api/lab/specimens/${c.specimen.id}/results`,
    { testCode: "GLY", value: 30 },
    TECH,
  );
  const view = (role: "doctor" | "lab", sub: string) =>
    call(role, "GET", `/api/lab/patients/${c.patient.id}/results`, undefined, sub);
  assert.equal(
    (await view("doctor", DR)).body.results.length,
    0,
    "le médecin ne voit pas le non-validé",
  );
  assert.equal((await view("lab", TECH)).body.results.length, 1);

  assert.equal(
    (await call("lab", "POST", `/api/lab/specimens/${c.specimen.id}/validate-biological`, {}, TECH))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        "biologist",
        "POST",
        `/api/lab/specimens/${c.specimen.id}/validate-biological`,
        {},
        BIO,
      )
    ).body.error.code,
    "not_tech_validated",
  );
  const empty = await collected();
  await call("lab", "POST", "/api/lab/specimens/receive", { scan: empty.specimen.payload }, TECH);
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        `/api/lab/specimens/${empty.specimen.id}/validate-technical`,
        {},
        TECH,
      )
    ).body.error.code,
    "results_missing",
  );

  assert.equal(
    (await call("lab", "POST", `/api/lab/specimens/${c.specimen.id}/validate-technical`, {}, TECH))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        "lab",
        "POST",
        `/api/lab/specimens/${c.specimen.id}/results`,
        { testCode: "GLY", value: 4 },
        TECH,
      )
    ).body.error.code,
    "result_locked",
  );
  assert.equal((await view("doctor", DR)).body.results.length, 0);

  // Même personne pour les deux temps : refusé (simulé en base, les deux rôles étant distincts par construction).
  await db.owner.query("update lab.results set tech_by = $1 where specimen_id = $2", [
    BIO,
    c.specimen.id,
  ]);
  assert.equal(
    (
      await call(
        "biologist",
        "POST",
        `/api/lab/specimens/${c.specimen.id}/validate-biological`,
        {},
        BIO,
      )
    ).body.error.code,
    "same_person",
  );
  await db.owner.query("update lab.results set tech_by = $1 where specimen_id = $2", [
    TECH,
    c.specimen.id,
  ]);

  const done = await call(
    "biologist",
    "POST",
    `/api/lab/specimens/${c.specimen.id}/validate-biological`,
    {},
    BIO,
  );
  assert.equal(done.status, 200, done.raw);
  assert.equal(done.body.requestComplete, true);
  const seen = (await view("doctor", DR)).body.results;
  assert.equal(seen.length, 1);
  assert.deepEqual(
    [seen[0].value, seen[0].flag, seen[0].loinc, seen[0].status],
    [30, "critical_high", "2345-7", "validated"],
  );
  const tk = await db.owner.query(
    "select status, completed_by from orders.department_tickets where code = $1",
    [c.request.ticketCode],
  );
  assert.deepEqual([tk.rows[0].status, tk.rows[0].completed_by], ["completed", BIO]);
  const ev = await db.owner.query(
    "select payload from events.outbox where type = 'LabResultValidated' and payload->>'specimenId' = $1",
    [c.specimen.id],
  );
  assert.equal(ev.rows[0].payload.hasCritical, true);
  assert.equal(ev.rows[0].payload.technicalBy.userId, TECH);
  assert.equal(ev.rows[0].payload.biologicalBy.userId, BIO);
  await assert.rejects(
    db.owner.query("update lab.results set value_numeric = 1 where specimen_id = $1", [
      c.specimen.id,
    ]),
    /ne se modifie plus/,
  );
  await assert.rejects(
    db.owner.query("delete from lab.results where specimen_id = $1", [c.specimen.id]),
    /ne se supprime pas/,
  );
  assert.equal(
    (await db.owner.query("select 1 from audit.log where action = 'lab.read'")).rowCount !== 0,
    true,
  );
});

test("F7-8 : compte rendu bilingue des résultats validés ; contrôle qualité journalier et graphique", async () => {
  await setGlyRanges();
  const c = await received();
  await call(
    "lab",
    "POST",
    `/api/lab/specimens/${c.specimen.id}/results`,
    { testCode: "GLY", value: 5.4 },
    TECH,
  );
  assert.equal(
    (await call("doctor", "GET", `/api/lab/requests/${c.request.id}/report`, undefined, DR)).body
      .error.code,
    "nothing_validated",
  );
  await call("lab", "POST", `/api/lab/specimens/${c.specimen.id}/validate-technical`, {}, TECH);
  await call(
    "biologist",
    "POST",
    `/api/lab/specimens/${c.specimen.id}/validate-biological`,
    {},
    BIO,
  );
  const rep = await call(
    "doctor",
    "GET",
    `/api/lab/requests/${c.request.id}/report`,
    undefined,
    DR,
  );
  assert.equal(rep.status, 200, rep.raw);
  assert.ok(
    rep.body.html.includes("Glycémie") &&
      rep.body.html.includes("سكر الدم") &&
      rep.body.html.includes("5.4") &&
      rep.body.html.includes("LOINC 2345-7"),
  );

  const noTarget = await call(
    "lab",
    "POST",
    "/api/lab/qc/runs",
    { testCode: "GLY", level: "N1", value: 5 },
    TECH,
  );
  assert.equal(noTarget.body.error.code, "no_qc_target");
  assert.equal(
    (
      await call(
        "lab",
        "PUT",
        "/api/lab/qc/targets",
        { testCode: "GLY", level: "N1", mean: 5, sd: 0.2, setOn: "2026-11-01" },
        TECH,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "biologist",
        "PUT",
        "/api/lab/qc/targets",
        { testCode: "GLY", level: "N1", mean: 5, sd: 0.2, setOn: "2026-11-01" },
        BIO,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("lab", "GET", "/api/lab/qc/status", undefined, TECH)).body.tests[0].doneToday,
    false,
  );
  const run = (value: number) =>
    call("lab", "POST", "/api/lab/qc/runs", { testCode: "GLY", level: "N1", value }, TECH);
  assert.equal((await run(5.1)).body.status, "ok");
  assert.equal((await run(5.5)).body.status, "warning");
  const rej = await run(5.7);
  assert.equal(rej.body.status, "reject");
  assert.equal(rej.body.zScore, 3.5);
  const status = (await call("lab", "GET", "/api/lab/qc/status", undefined, TECH)).body.tests[0];
  assert.deepEqual([status.doneToday, status.ok], [true, false], "dernier contrôle rejeté");
  const series = await call(
    "lab",
    "GET",
    "/api/lab/qc/series?testCode=GLY&level=N1",
    undefined,
    TECH,
  );
  assert.equal(series.body.points.length, 3);
  assert.ok(Math.abs(series.body.limits.rejectHigh - 5.6) < 1e-9);
  assert.equal(series.body.mean, 5);
  await assert.rejects(
    db.owner.query("update lab.qc_runs set value = 5"),
    /ne se modifie ni ne se supprime/,
  );
});

test("la liste de travail des échantillons montre l'état, les analyses et les résultats", async () => {
  await setGlyRanges();
  const c = await received();
  await call(
    "lab",
    "POST",
    `/api/lab/specimens/${c.specimen.id}/results`,
    { testCode: "GLY", value: 7 },
    TECH,
  );
  const list = await call("lab", "GET", "/api/lab/specimens?status=received", undefined, TECH);
  assert.equal(list.status, 200, list.raw);
  const row = list.body.specimens.find((s: { id: string }) => s.id === c.specimen.id);
  assert.equal(row.patient.identifier, c.patient.identifier);
  assert.equal(row.payload, c.specimen.payload);
  assert.deepEqual(
    [row.tests[0].testCode, row.tests[0].value, row.tests[0].flag, row.tests[0].resultStatus],
    ["GLY", 7, "high", "entered"],
  );
  assert.equal(
    list.body.specimens.every((s: { status: string }) => s.status === "received"),
    true,
  );
  assert.equal((await call("doctor", "GET", "/api/lab/specimens", undefined, DR)).status, 403);
});
