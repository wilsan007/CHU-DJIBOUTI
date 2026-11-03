import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cardPayload } from "../src/modules/identity/card.ts";
import {
  cancelMine,
  myResults,
  OTP_MAX_ATTEMPTS,
  requestOtp,
  verifyOtp,
  authenticatePatient,
  type PortalConfig,
} from "../src/modules/portal/service.ts";
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
const sent: { to: string; text: string }[] = [];
const cfg: PortalConfig = {
  provider: { send: async (m) => void sent.push(m) },
  secret: new TextEncoder().encode("secret-de-test-secret-de-test-0123456789"),
  resultDelayHours: 24,
};
const DR = "dr-portal";
const CASHIER = "caissier-portal";
const TECH = "tech-portal";
const BIO = "bio-portal";
const PRACT = "dr-agenda-portal";
let ipCounter = 0;
const newIp = () => `10.0.0.${++ipCounter}`;

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app, { portal: cfg });
  call = makeCaller(t);
  await importCatalogs(call);
  await openCash(call, CASHIER);
  const imp = await call(
    "biologist",
    "POST",
    "/api/lab/tests/import",
    "code,loinc,act_code,libelle_fr,libelle_ar,echantillon,unite,type_valeur,responsable,date_maj\nGLY,2345-7,LAB-GLY,Glycémie,سكر الدم,Sérum,mmol/L,numeric,Biologiste test,2026-11-01\n",
    BIO,
  );
  assert.equal(imp.status, 200, imp.raw);
  await call("admin", "PUT", `/api/schedule/practitioners/${PRACT}`, {
    displayName: "Dr Agenda",
    departmentCode: "CONS",
  });
  await call("admin", "PUT", `/api/schedule/practitioners/${PRACT}/availability`, {
    rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      start: "08:00",
      end: "10:00",
      slotMinutes: 30,
    })),
  });
});
after(async () => {
  await t.close();
  await db.drop();
});

const post = (url: string, payload: unknown, token?: string, ip = newIp()) =>
  t.app.inject({
    method: "POST",
    url,
    payload: payload as object,
    remoteAddress: ip,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
const get = (url: string, token?: string) =>
  t.app.inject({
    method: "GET",
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
const lastCode = () => /(\d{6})/.exec(sent.at(-1)!.text)![1]!;

async function login(identifier: string) {
  const before = sent.length;
  const ip = newIp();
  assert.equal(
    (await post("/api/portal/otp/request", { identifier }, undefined, ip)).statusCode,
    202,
  );
  await new Promise((r) => setTimeout(r, 20)); // l'envoi n'est pas attendu
  assert.equal(sent.length, before + 1, "un SMS envoyé");
  const res = await post("/api/portal/otp/verify", { identifier, code: lastCode() }, undefined, ip);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

test("code par SMS : même réponse pour un dossier connu ou inconnu ; code jamais en clair en base", async () => {
  const p = await newPatient(call, "Portail");
  sent.length = 0;
  const known = await post("/api/portal/otp/request", { identifier: p.identifier });
  const unknown = await post("/api/portal/otp/request", { identifier: "999999" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(known.statusCode, 202);
  assert.equal(unknown.statusCode, 202);
  assert.equal(
    known.body,
    unknown.body,
    "réponses identiques : on ne devine pas les dossiers existants",
  );
  assert.equal(sent.length, 1, "seul le dossier connu reçoit un SMS");
  assert.match(sent[0]!.text, /\d{6}/);
  assert.match(sent[0]!.text, /رمز/, "message bilingue");
  const stored = await db.owner.query(
    "select code_hash, salt from portal.otp_challenges where patient_id = $1",
    [p.id],
  );
  assert.ok(
    !stored.rows[0].code_hash.includes(lastCode()) && stored.rows[0].code_hash.length === 64,
    "haché, jamais en clair",
  );
});

test("tentatives limitées : 5 erreurs brûlent le code ; 4e demande de l'heure sans SMS ; limite par adresse", async () => {
  const p = await newPatient(call, "Essais");
  sent.length = 0;
  const ip = newIp();
  await post("/api/portal/otp/request", { identifier: p.identifier }, undefined, ip);
  await new Promise((r) => setTimeout(r, 20));
  const good = lastCode();
  const bad = good === "000000" ? "111111" : "000000";
  for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
    const r = await post(
      "/api/portal/otp/verify",
      { identifier: p.identifier, code: bad },
      undefined,
      ip,
    );
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, "invalid_code");
  }
  const burnt = await post(
    "/api/portal/otp/verify",
    { identifier: p.identifier, code: good },
    undefined,
    ip,
  );
  assert.equal(burnt.statusCode, 401, "le bon code ne marche plus après 5 erreurs");
  // Demandes : 3 par heure et par patient, la 4e est muette (même réponse 202).
  for (let i = 0; i < 4; i += 1)
    await post("/api/portal/otp/request", { identifier: p.identifier }, undefined, newIp());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 3, "1 + 2 nouveaux codes, le suivant refusé en silence");
  // Par adresse : 20 demandes par heure.
  const spam = newIp();
  for (let i = 0; i < 20; i += 1)
    await post("/api/portal/otp/request", { identifier: "999999" }, undefined, spam);
  assert.equal(
    (await post("/api/portal/otp/request", { identifier: "999999" }, undefined, spam)).statusCode,
    429,
  );
});

test("code expiré refusé ; format invalide refusé ; portail désactivé sans clé", async () => {
  const p = await newPatient(call, "Expire");
  sent.length = 0;
  const now = new Date();
  await requestOtp(db.app, cfg, { identifier: p.identifier, ip: "9.9.9.9" }, now);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    verifyOtp(
      db.app,
      cfg,
      { identifier: p.identifier, code: lastCode(), ip: "9.9.9.9" },
      new Date(now.getTime() + 11 * 60_000),
    ),
    /invalide|expiré|incorrect/i,
  );
  assert.equal(
    (await post("/api/portal/otp/verify", { identifier: p.identifier, code: "12" })).statusCode,
    400,
  );
  await assert.rejects(
    requestOtp(db.app, { ...cfg, secret: null }, { identifier: p.identifier, ip: "9.9.9.9" }),
    /pas activé/,
  );
});

test("session : accès à son propre dossier ; jeton falsifié, expiré, déconnexion, staff ↔ patient refusés", async () => {
  const p = await newPatient(call, "Session");
  const token = await login(p.identifier);
  const me = await get("/api/portal/me", token);
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().identifier, p.identifier);
  assert.equal((await get("/api/portal/me")).statusCode, 401, "sans jeton");
  assert.equal((await get("/api/portal/me", token + "x")).statusCode, 401, "jeton altéré");
  assert.equal(
    (await get("/api/portal/me", await t.token(["doctor"]))).statusCode,
    401,
    "un jeton du personnel n'ouvre pas le portail",
  );
  assert.equal(
    (
      await t.app.inject({
        method: "GET",
        url: "/api/patients",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    401,
    "un jeton patient n'ouvre aucune route du personnel",
  );
  await assert.rejects(
    authenticatePatient(db.app, cfg, token, new Date(Date.now() + 31 * 60_000)),
    /expirée/,
  );
  assert.equal((await post("/api/portal/logout", {}, token)).statusCode, 204);
  assert.equal((await get("/api/portal/me", token)).statusCode, 401, "déconnexion immédiate");
  assert.ok(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'portal.login' and patient_id = $1",
        [p.id],
      )
    ).rowCount === 1,
    "connexion tracée",
  );
});

test("toute route du portail hors code exige une session (aucune ouverture par oubli)", async () => {
  const table = (t.app as unknown as { portalRoutes: { method: string; url: string }[] })
    .portalRoutes;
  const paths = [
    ...new Set(table.map((r) => r.url.replace(/:\w+/g, "00000000-0000-0000-0000-000000000000"))),
  ];
  assert.ok(paths.length >= 6, `routes : ${paths.join(", ")}`);
  const open = new Set(["/api/portal/otp/request", "/api/portal/otp/verify"]);
  for (const path of paths.filter((x) => !open.has(x))) {
    const codes = [(await get(path)).statusCode, (await post(path, {})).statusCode];
    assert.ok(
      codes.includes(401),
      `${path} : ${codes} (au moins une méthode doit répondre 401 sans jeton)`,
    );
    assert.ok(!codes.some((c) => c === 200 || c === 201), `${path} répond sans session`);
  }
});

test("rendez-vous : créneaux libres, prise, plafond de 3, annulation de ses seuls rendez-vous, pas trop tard", async () => {
  const a = await newPatient(call, "Agenda");
  const b = await newPatient(call, "Autre");
  const ta = await login(a.identifier);
  const tb = await login(b.identifier);
  assert.deepEqual((await get("/api/portal/practitioners", ta)).json().practitioners, [
    { id: PRACT, name: "Dr Agenda" },
  ]);
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const slots = (await get(`/api/portal/practitioners/${PRACT}/slots?date=${day}`, ta)).json()
    .slots as { startsAt: string; status: string }[];
  assert.ok(slots.length >= 3 && slots.every((s) => s.status === "free"));
  const booked: string[] = [];
  for (const s of slots.slice(0, 3)) {
    const r = await post(
      "/api/portal/me/appointments",
      { practitionerId: PRACT, startsAt: s.startsAt },
      ta,
    );
    assert.equal(r.statusCode, 201, r.body);
    booked.push(r.json().id);
  }
  const fourth = await post(
    "/api/portal/me/appointments",
    { practitionerId: PRACT, startsAt: slots[3]?.startsAt ?? slots[0]!.startsAt },
    ta,
  );
  assert.equal(fourth.json().error.code, "too_many_appointments");
  // Le créneau pris n'est plus proposé ; un autre patient ne peut pas le prendre.
  const again = (await get(`/api/portal/practitioners/${PRACT}/slots?date=${day}`, tb)).json()
    .slots as { startsAt: string }[];
  assert.ok(!again.some((s) => s.startsAt === slots[0]!.startsAt));
  assert.equal(
    (
      await post(
        "/api/portal/me/appointments",
        { practitionerId: PRACT, startsAt: slots[0]!.startsAt },
        tb,
      )
    ).json().error.code,
    "slot_taken",
  );
  assert.equal((await get("/api/portal/me/appointments", ta)).json().appointments.length, 3);
  assert.equal(
    (await get("/api/portal/me/appointments", tb)).json().appointments.length,
    0,
    "chacun ne voit que les siens",
  );
  // Annulation : jamais celui d'un autre (404, pas 403 : on ne confirme pas son existence).
  assert.equal(
    (await post(`/api/portal/me/appointments/${booked[0]}/cancel`, {}, tb)).statusCode,
    404,
  );
  assert.equal(
    (await post(`/api/portal/me/appointments/${booked[0]}/cancel`, {}, ta)).statusCode,
    200,
  );
  assert.equal((await get("/api/portal/me/appointments", ta)).json().appointments.length, 2);
  // Trop tard : moins de 2 heures avant.
  const s = await newPatient(call, "Tard");
  const sess = await authenticatePatient(db.app, cfg, await login(s.identifier));
  const slot =
    (await get(`/api/portal/practitioners/${PRACT}/slots?date=${day}`, ta)).json().slots[5]
      ?.startsAt ?? slots[0]!.startsAt;
  const made = await post(
    "/api/portal/me/appointments",
    { practitionerId: PRACT, startsAt: slot },
    await login(s.identifier),
  );
  assert.equal(made.statusCode, 201, made.body);
  await assert.rejects(
    cancelMine(db.app, sess, made.json().id, "r", new Date(new Date(slot).getTime() - 3_600_000)),
    /moins de 2 heures/,
  );
});

async function validated() {
  const patient = await newPatient(call, "Resultat");
  const adm = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    {
      patientId: patient.id,
      encounterId: adm.encounter.id,
      items: [{ actCode: "LAB-GLY", quantity: 1 }],
    },
    DR,
  );
  await t.dispatcher.drain();
  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${order.body.number}`,
    undefined,
    CASHIER,
  );
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  await t.dispatcher.drain();
  const req = (
    await call("lab", "GET", `/api/lab/requests?patientId=${patient.id}`, undefined, TECH)
  ).body.requests[0];
  const sp = await call(
    "lab",
    "POST",
    `/api/lab/requests/${req.id}/collect`,
    { patientScan: cardPayload(patient.identifier), specimenType: "Sérum" },
    TECH,
  );
  return { patient, sp, req, order };
}

test("résultats : validés seulement, après le délai, valeur critique jamais affichée", async () => {
  await call(
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
  const results: Record<string, string> = {};
  for (const [label, value] of [
    ["normal", 5.2],
    ["critique", 30],
  ] as const) {
    const v = await validated();
    assert.equal(v.sp.status, 201, v.sp.raw);
    const spec = v.sp.body;
    await call("lab", "POST", "/api/lab/specimens/receive", { scan: spec.payload }, TECH);
    await call(
      "lab",
      "POST",
      `/api/lab/specimens/${spec.id}/results`,
      { testCode: "GLY", value },
      TECH,
    );
    await call("lab", "POST", `/api/lab/specimens/${spec.id}/validate-technical`, {}, TECH);
    const bio = await call(
      "biologist",
      "POST",
      `/api/lab/specimens/${spec.id}/validate-biological`,
      {},
      BIO,
    );
    assert.equal(bio.status, 200, bio.raw);
    results[label] = v.patient.identifier;
    const token = await login(v.patient.identifier);
    const early = (await get("/api/portal/me/results", token)).json();
    assert.deepEqual(early.results, [], "rien avant le délai de 24 h");
    assert.equal(early.pendingCount, 1);
    const sess = await authenticatePatient(db.app, cfg, token);
    const later = await myResults(db.app, cfg, sess, "r", new Date(Date.now() + 25 * 3_600_000));
    if (label === "normal") {
      assert.equal(later.results.length, 1);
      assert.equal(later.results[0]!.value, 5.2);
      assert.equal(later.withheld, 0);
    } else {
      assert.equal(later.results.length, 0, "la valeur critique n'est jamais montrée");
      assert.equal(later.withheld, 1, "mais le patient est invité à contacter son médecin");
    }
  }
});

test("factures : les siennes seulement, sans détail des autres ; lecture tracée", async () => {
  const p = await newPatient(call, "Facture");
  const adm = await admitPatient(call, p.id);
  void adm;
  const token = await login(p.identifier);
  const mine = (await get("/api/portal/me/invoices", token)).json().invoices as {
    number: string;
    patientAmount: number;
  }[];
  assert.ok(mine.length >= 1);
  const other = await newPatient(call, "Autre");
  await admitPatient(call, other.id);
  const all = (
    await call("cashier", "GET", "/api/billing/invoices?status=pending", undefined, CASHIER)
  ).body.invoices as { number: string; patientId: string }[];
  const theirs = all.filter((i) => i.patientId === other.id).map((i) => i.number);
  assert.ok(theirs.length >= 1 && !mine.some((i) => theirs.includes(i.number)));
  assert.ok(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'portal.invoices.read' and patient_id = $1",
        [p.id],
      )
    ).rowCount! >= 1,
  );
});
