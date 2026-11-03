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
before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
});
after(async () => {
  await t.close();
  await db.drop();
});

const num = (invoiceNumber: string) => Number(invoiceNumber.split("-")[1]);

/* ------------------------------------------------------------------ F2-1 admission */

test("F2-1 : une seule requête admet le patient, ouvre l'acte et émet la facture", async () => {
  const p = await newPatient(call);
  const res = await call("reception", "POST", "/api/admissions", {
    patientId: p.id,
    departmentCode: "CONS",
    payerCode: "DIRECT",
    actCode: "CONS-GEN",
  });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.encounter.status, "open");
  assert.equal(res.body.invoice.total, 2000);
  assert.equal(res.body.invoice.status, "pending");
  assert.match(res.body.invoice.number, /^F-\d{6}$/);
  assert.equal(res.body.invoice.lines[0].actCode, "CONS-GEN");
  const events = await db.owner.query(
    "select type from events.outbox where patient_id = $1 order by id",
    [p.id],
  );
  assert.deepEqual(
    events.rows.map((e) => e.type),
    ["PatientCreated", "InvoiceIssued", "EncounterStarted"],
  );
  const audit = await db.owner.query(
    "select action from audit.log where patient_id = $1 and action in ('encounter.open', 'invoice.issue') order by id",
    [p.id],
  );
  assert.deepEqual(
    audit.rows.map((a) => a.action),
    ["encounter.open", "invoice.issue"],
  );
});

test("F2-1 : refus clairs : mauvais acte, mauvais service, patient absent, double admission", async () => {
  const p = await newPatient(call);
  const base = {
    patientId: p.id,
    departmentCode: "CONS",
    payerCode: "DIRECT",
    actCode: "CONS-GEN",
  };
  assert.equal(
    (await call("reception", "POST", "/api/admissions", { ...base, actCode: "LAB-GLY" })).body.error
      .code,
    "act_not_admission",
  );
  assert.equal(
    (await call("reception", "POST", "/api/admissions", { ...base, departmentCode: "URG" })).body
      .error.code,
    "act_department_mismatch",
  );
  assert.equal(
    (await call("reception", "POST", "/api/admissions", { ...base, payerCode: "INCONNU" })).status,
    404,
  );
  assert.equal(
    (
      await call("reception", "POST", "/api/admissions", {
        ...base,
        patientId: "00000000-0000-4000-8000-000000000000",
      })
    ).status,
    404,
  );
  const ok = await call("reception", "POST", "/api/admissions", base);
  assert.equal(ok.status, 201);
  const again = await call("reception", "POST", "/api/admissions", base);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "encounter_already_open");
  assert.equal(again.body.error.details.encounterId, ok.body.encounter.id);
});

test("F2-1 : un dossier fusionné ne peut pas être admis, on utilise le dossier conservé", async () => {
  const keep = await newPatient(call, "Garde");
  const old = await newPatient(call, "Ancien");
  await call("admin", "POST", "/api/patients/merge", {
    survivorId: keep.id,
    mergedId: old.id,
    reason: "même personne",
  });
  const res = await call("reception", "POST", "/api/admissions", {
    patientId: old.id,
    departmentCode: "CONS",
    payerCode: "DIRECT",
    actCode: "CONS-GEN",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "patient_merged");
  assert.equal(res.body.error.details.survivorId, keep.id);
});

/* ------------------------------------------------------------------ F2-3 payeurs */

test("F2-3 : part patient et part payeur selon le payeur, somme exacte", async () => {
  const cases: [string, number, number][] = [
    ["DIRECT", 2000, 0],
    ["ASSUR", 400, 1600],
    ["GRATUIT", 0, 2000],
  ];
  for (const [payer, patientAmount, payerAmount] of cases) {
    const p = await newPatient(call);
    const { invoice } = await admitPatient(call, p.id, { payer });
    assert.equal(invoice.patientAmount, patientAmount, payer);
    assert.equal(invoice.payerAmount, payerAmount, payer);
    assert.equal(invoice.patientAmount + invoice.payerAmount, invoice.total);
  }
});

/* ------------------------------------------------------------------ F2-4 devis, numérotation, avoirs */

test("F2-4 : devis avant l'acte, rien n'est enregistré", async () => {
  const before = (await db.owner.query("select count(*)::int as n from billing.invoices")).rows[0]
    .n;
  const res = await call("reception", "POST", "/api/billing/quotes", {
    payerCode: "ASSUR",
    items: [
      { actCode: "LAB-GLY", quantity: 2 },
      { actCode: "IMG-RX", quantity: 1 },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 9000);
  assert.equal(res.body.patientAmount, 1800);
  assert.equal(res.body.payerAmount, 7200);
  const after = (await db.owner.query("select count(*)::int as n from billing.invoices")).rows[0].n;
  assert.equal(after, before);
  assert.equal(
    (
      await call("reception", "POST", "/api/billing/quotes", {
        payerCode: "DIRECT",
        items: [{ actCode: "NOPE", quantity: 1 }],
      })
    ).status,
    404,
  );
});

test("F2-4 : numérotation continue sans trou, même avec des émissions simultanées", async () => {
  const patients = await Promise.all(Array.from({ length: 8 }, () => newPatient(call)));
  const results = await Promise.all(patients.map((p) => admitPatient(call, p.id)));
  const numbers = results.map((r) => num(r.invoice.number)).sort((a, b) => a - b);
  for (let i = 1; i < numbers.length; i += 1)
    assert.equal(numbers[i], (numbers[i - 1] as number) + 1, numbers.join(","));
  const all = (
    await db.owner.query(
      "select number from billing.invoices where kind = 'invoice' order by number",
    )
  ).rows.map((r) => num(r.number));
  assert.deepEqual(
    all,
    all.map((_, i) => i + 1),
    "aucun trou dans toute la série",
  );
});

test("F2-4 : un échec d'émission ne consomme aucun numéro", async () => {
  const p = await newPatient(call);
  const before = (await db.owner.query("select value from billing.counters where name = 'invoice'"))
    .rows[0].value;
  const res = await call("reception", "POST", "/api/admissions", {
    patientId: p.id,
    departmentCode: "CONS",
    payerCode: "DIRECT",
    actCode: "ACTE-INEXISTANT",
  });
  assert.equal(res.status, 404);
  const after = (await db.owner.query("select value from billing.counters where name = 'invoice'"))
    .rows[0].value;
  assert.equal(after, before);
});

test("F2-4 : une facture émise n'est plus modifiable, même par le propriétaire de la base", async () => {
  const p = await newPatient(call);
  const { invoice } = await admitPatient(call, p.id);
  await assert.rejects(
    () => db.owner.query("update billing.invoices set total = 1 where id = $1", [invoice.id]),
    /plus modifiable/,
  );
  await assert.rejects(
    () =>
      db.owner
        .query("update billing.invoices set patient_id = $2 where id = $1", [invoice.id, p.id])
        .then(() =>
          db.owner.query("update billing.invoices set number = 'F-999999' where id = $1", [
            invoice.id,
          ]),
        ),
    /plus modifiable/,
  );
  await assert.rejects(
    () => db.owner.query("delete from billing.invoices where id = $1", [invoice.id]),
    /avoir/,
  );
  await assert.rejects(
    () =>
      db.owner.query("update billing.invoice_lines set quantity = 9 where invoice_id = $1", [
        invoice.id,
      ]),
    /ajout seul/,
  );
  await assert.rejects(
    () => db.app.query("update billing.invoices set total = 1 where id = $1", [invoice.id]),
    /plus modifiable/,
  );
});

test("F2-4 : la correction passe par un avoir numéroté, une seule fois", async () => {
  const p = await newPatient(call);
  const { invoice } = await admitPatient(call, p.id, { payer: "ASSUR" });
  assert.equal(
    (
      await call("reception", "POST", `/api/billing/invoices/${invoice.id}/credit-note`, {
        reason: "erreur de saisie",
      })
    ).status,
    403,
  );
  const res = await call("cashier", "POST", `/api/billing/invoices/${invoice.id}/credit-note`, {
    reason: "erreur de saisie",
  });
  assert.equal(res.status, 201, res.raw);
  assert.match(res.body.creditNote.number, /^A-\d{6}$/);
  assert.equal(res.body.creditNote.total, -2000);
  assert.equal(res.body.creditNote.patientAmount, -400);
  assert.equal(res.body.original.status, "credited");
  const again = await call("cashier", "POST", `/api/billing/invoices/${invoice.id}/credit-note`, {
    reason: "encore",
  });
  assert.equal(again.status, 409);
  const onCredit = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${res.body.creditNote.id}/credit-note`,
    { reason: "avoir d'un avoir" },
  );
  assert.equal(onCredit.status, 400);
  const noReason = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/credit-note`,
    {},
  );
  assert.equal(noReason.status, 400);
  await openCash(call);
  const pay = await call("cashier", "POST", `/api/billing/invoices/${invoice.id}/pay`, {
    method: "cash",
  });
  assert.equal(pay.body.error.code, "credited", "on ne paie pas une facture annulée");
});

/* ------------------------------------------------------------------ F2-5 caisse */

test("F2-5 : il faut une caisse ouverte pour encaisser ; une caisse par caissier", async () => {
  const p = await newPatient(call);
  const { invoice } = await admitPatient(call, p.id);
  const sub = "caissier-sans-caisse";
  const refused = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "cash" },
    sub,
  );
  assert.equal(refused.body.error.code, "no_cash_session");
  await openCash(call, sub);
  const again = await call("cashier", "POST", "/api/billing/cash-sessions/open", undefined, sub);
  assert.equal(again.status, 409);
  const current = await call(
    "cashier",
    "GET",
    "/api/billing/cash-sessions/current",
    undefined,
    sub,
  );
  assert.ok(current.body.session);
});

test("F2-5 : encaissement, monnaie, reçu numéroté, paiement unique", async () => {
  const sub = "caissier-encaissement";
  await openCash(call, sub);
  const p = await newPatient(call);
  const { invoice } = await admitPatient(call, p.id);
  const pay = (body: unknown) =>
    call("cashier", "POST", `/api/billing/invoices/${invoice.id}/pay`, body, sub);
  assert.equal(
    (await pay({ method: "cash", receivedAmount: 1000 })).body.error.code,
    "insufficient_amount",
  );
  assert.equal((await pay({ method: "exempt" })).body.error.code, "exempt_not_allowed");
  const ok = await pay({ method: "cash", receivedAmount: 5000 });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.body.change, 3000);
  assert.equal(ok.body.invoice.status, "paid");
  assert.match(ok.body.payment.receiptNumber, /^R-\d{6}$/);
  assert.equal(ok.body.payment.cashierId, sub);
  assert.equal((await pay({ method: "cash" })).body.error.code, "already_paid");
  const receipt = await call("cashier", "GET", `/api/billing/invoices/${invoice.id}/receipt`);
  assert.equal(receipt.body.receiptNumber, ok.body.payment.receiptNumber);
  assert.equal(receipt.body.lines[0].labelAr, "استشارة عامة");
  assert.equal(receipt.body.amount, 2000);
  const unpaid = await admitPatient(call, (await newPatient(call)).id);
  assert.equal(
    (await call("cashier", "GET", `/api/billing/invoices/${unpaid.invoice.id}/receipt`)).body.error
      .code,
    "not_paid",
  );
});

test("F2-5 : montant dû nul : validation « exempt » obligatoire par la caisse", async () => {
  const sub = "caissier-exempt";
  await openCash(call, sub);
  const { invoice } = await admitPatient(call, (await newPatient(call)).id, { payer: "GRATUIT" });
  const cash = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "cash" },
    sub,
  );
  assert.equal(cash.body.error.code, "use_exempt");
  const ok = await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${invoice.id}/pay`,
    { method: "exempt" },
    sub,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.payment.amount, 0);
});

test("F2-5 : la réception ne peut pas encaisser, la caisse ne peut pas admettre", async () => {
  const { invoice } = await admitPatient(call, (await newPatient(call)).id);
  assert.equal(
    (await call("reception", "POST", `/api/billing/invoices/${invoice.id}/pay`, { method: "cash" }))
      .status,
    403,
  );
  assert.equal(
    (await call("doctor", "POST", `/api/billing/invoices/${invoice.id}/pay`, { method: "cash" }))
      .status,
    403,
  );
  const p = await newPatient(call);
  assert.equal(
    (
      await call("cashier", "POST", "/api/admissions", {
        patientId: p.id,
        departmentCode: "CONS",
        payerCode: "DIRECT",
        actCode: "CONS-GEN",
      })
    ).status,
    403,
  );
});

test("F2-5 : clôture de caisse, l'écart est enregistré ; pas la caisse d'un autre", async () => {
  const sub = "caissier-cloture";
  const session = await openCash(call, sub);
  let cashTotal = 0;
  for (const payer of ["DIRECT", "ASSUR"]) {
    const { invoice } = await admitPatient(call, (await newPatient(call)).id, { payer });
    await call(
      "cashier",
      "POST",
      `/api/billing/invoices/${invoice.id}/pay`,
      { method: "cash" },
      sub,
    );
    cashTotal += invoice.patientAmount;
  }
  const { invoice: mobile } = await admitPatient(call, (await newPatient(call)).id);
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${mobile.id}/pay`,
    { method: "mobile" },
    sub,
  );
  assert.equal(cashTotal, 2400);
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/cash-sessions/${session.id}/close`,
        { countedCash: 2400 },
        "autre-caissier",
      )
    ).status,
    403,
  );
  const closed = await call(
    "cashier",
    "POST",
    `/api/billing/cash-sessions/${session.id}/close`,
    { countedCash: 2300 },
    sub,
  );
  assert.equal(closed.status, 200, closed.raw);
  assert.equal(closed.body.expectedCash, 2400, "seuls les paiements en espèces comptent");
  assert.equal(closed.body.difference, -100);
  assert.equal(
    (
      await call(
        "cashier",
        "POST",
        `/api/billing/cash-sessions/${session.id}/close`,
        { countedCash: 2400 },
        sub,
      )
    ).status,
    409,
  );
  const audit = await db.owner.query(
    "select detail from audit.log where action = 'cash.close' and entity_id = $1",
    [session.id],
  );
  assert.equal(audit.rows[0].detail.difference, -100);
  await openCash(call, sub); // une nouvelle caisse peut s'ouvrir après la clôture
});

/* ------------------------------------------------------------------ F2-6 rapport */

test("F2-6 : le total du rapport est la somme des reçus, par jour, caissier et service", async () => {
  const subA = "caissier-rapport-a";
  const subB = "caissier-rapport-b";
  await openCash(call, subA);
  await openCash(call, subB);
  const paid: number[] = [];
  for (const [sub, payer] of [
    [subA, "DIRECT"],
    [subA, "ASSUR"],
    [subB, "DIRECT"],
  ] as const) {
    const { invoice } = await admitPatient(call, (await newPatient(call)).id, { payer });
    const res = await call(
      "cashier",
      "POST",
      `/api/billing/invoices/${invoice.id}/pay`,
      { method: "cash" },
      sub,
    );
    paid.push(res.body.payment.amount);
  }
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const sumReceipts = Number(
    (await db.owner.query("select sum(amount) as s from billing.payments")).rows[0].s,
  );
  for (const groupBy of ["day", "cashier", "department"]) {
    const res = await call(
      "cashier",
      "GET",
      `/api/billing/reports/revenue?from=${today}&to=${today}&groupBy=${groupBy}`,
    );
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.total, sumReceipts, groupBy);
    const sumRows = res.body.rows.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
    assert.equal(sumRows, sumReceipts, `${groupBy} : les lignes totalisent le même montant`);
  }
  const byCashier = (
    await call(
      "cashier",
      "GET",
      `/api/billing/reports/revenue?from=${today}&to=${today}&groupBy=cashier`,
    )
  ).body.rows;
  assert.equal(byCashier.find((r: { key: string }) => r.key === subA).amount, paid[0]! + paid[1]!);
  assert.equal(byCashier.find((r: { key: string }) => r.key === subB).amount, paid[2]);
  const csv = await call(
    "direction",
    "GET",
    `/api/billing/reports/revenue?from=${today}&to=${today}&groupBy=day&format=csv`,
  );
  assert.equal(csv.status, 200);
  assert.match(csv.raw, /^groupe,libelle,recus,montant_fdj\n/);
  assert.match(csv.raw, new RegExp(`TOTAL,,\\d+,${sumReceipts}\\n$`));
  const past = await call(
    "cashier",
    "GET",
    "/api/billing/reports/revenue?from=2020-01-01&to=2020-01-02",
  );
  assert.equal(past.body.total, 0);
});

test("F2-6 : la direction lit les recettes mais ne voit aucune facture ni aucun patient", async () => {
  assert.equal(
    (await call("direction", "GET", "/api/billing/reports/revenue?from=2026-01-01&to=2026-12-31"))
      .status,
    200,
  );
  assert.equal((await call("direction", "GET", "/api/billing/invoices")).status, 403);
  assert.equal((await call("direction", "GET", "/api/patients?q=test")).status, 403);
  assert.equal(
    (await call("lab", "GET", "/api/billing/reports/revenue?from=2026-01-01&to=2026-12-31")).status,
    403,
  );
});
