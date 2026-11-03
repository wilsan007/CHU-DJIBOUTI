// Écrans du laboratoire et de la pharmacie, dans un vrai navigateur (Keycloak, API et PostgreSQL réels).
import assert from "node:assert/strict";
import {
  ACTS_CSV,
  api,
  cardPayload,
  chromium,
  importCatalogs,
  login,
  shot,
  sleep,
} from "./lib.mjs";

const until = async (fn, what, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`Délai dépassé : ${what}`);
};
void ACTS_CSV;

const suffix = String(Date.now()).slice(-6);
// Médicaments propres à cette exécution : le stock et les lots de départ sont connus, le test est rejouable.
const PAR = `ZP${suffix}`;
const AMO = `ZA${suffix}`;
let phone = Number(suffix) * 10;

async function newPatient(name) {
  phone += 1;
  const res = await api("dev-reception", "/api/patients", {
    method: "POST",
    body: {
      givenName: name,
      familyName: `Test${suffix}`,
      sex: "female",
      birthDate: "1990-05-12",
      phone: `0077${phone}`,
      confirmNotDuplicate: true,
    },
    expect: 201,
  });
  return res.data;
}
async function admit(patientId) {
  return (
    await api("dev-reception", "/api/admissions", {
      method: "POST",
      body: { patientId, departmentCode: "CONS", payerCode: "DIRECT", actCode: "CONS-GEN" },
      expect: 201,
    })
  ).data;
}
async function ensureCash() {
  await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
}
async function payByOrder(orderNumber) {
  const inv = await until(
    async () =>
      (await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${orderNumber}`))
        .data.invoices[0],
    "facture de la demande",
  );
  await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
    method: "POST",
    body: { method: "cash", receivedAmount: 1_000_000 },
    expect: 200,
  });
}

const browser = await chromium.launch();
try {
  await importCatalogs();
  await api("dev-admin", "/api/catalog/drugs/import", {
    method: "POST",
    csv: `code,dci,forme,dosage,libelle_ar,classe_allergie,classe_interaction,responsable,date_maj\n${PAR},Paracétamol,Comprimé,500 mg ${suffix},باراسيتامول,,,Pharmacien test,2026-11-01\n${AMO},Amoxicilline,Gélule,500 mg ${suffix},أموكسيسيلين,penicillin,,Pharmacien test,2026-11-01\n`,
    expect: 200,
  });
  await ensureCash();
  const ranges = await api("dev-biologist", "/api/lab/tests/GLY/ranges", {
    method: "PUT",
    body: {
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
  });
  assert.equal(ranges.status, 200);

  /* ------------------------------------------------------------ laboratoire */
  const patient = await newPatient("Labo");
  const other = await newPatient("Autre");
  const adm = await admit(patient.id);
  const order = (
    await api("dev-doctor", "/api/service-orders", {
      method: "POST",
      body: {
        patientId: patient.id,
        encounterId: adm.encounter.id,
        items: [{ actCode: "LAB-GLY", quantity: 1 }],
      },
      expect: 201,
    })
  ).data;
  await payByOrder(order.number);
  const request = await until(
    async () =>
      (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests[0],
    "demande du laboratoire après paiement",
  );

  const lab = await login(browser, "dev-lab");
  const card = lab.locator(`[data-request='${request.number}']`);
  await card.waitFor();
  await shot(lab, "10-labo-a-prelever");

  // Mauvaise carte : refusé. Bonne carte : prélevé, étiquette ouverte.
  await card.locator("input[placeholder='CHU1.000001.00']").fill(await cardPayload(other.id));
  await card.locator("button:has-text('Prélever')").click();
  await card.locator("[role=alert]:has-text('pas celle du patient')").waitFor();
  await card.locator("input[placeholder='CHU1.000001.00']").fill(await cardPayload(patient.id));
  const [popup] = await Promise.all([
    lab.waitForEvent("popup"),
    card.locator("button:has-text('Prélever')").click(),
  ]);
  const notice = await lab.waitForSelector("[role=status]:has-text('prélevé')");
  const specimenNumber = (await notice.textContent()).match(/S-\d{6}/)[0];
  await popup.waitForLoadState();
  assert.ok(
    (await popup.content()).includes(specimenNumber),
    "l'étiquette porte le numéro de l'échantillon",
  );
  await popup.close();

  // Réception : un code altéré est refusé ; le bon code est accepté.
  const sp = lab.locator(`[data-specimen='${specimenNumber}']`);
  await sp.waitFor();
  const payload = (await api("dev-lab", "/api/lab/specimens?status=collected")).data.specimens.find(
    (s) => s.number === specimenNumber,
  ).payload;
  const tampered = payload.replace(/\d{2}$/, (d) => String((Number(d) + 1) % 100).padStart(2, "0"));
  await sp.locator("input[placeholder='SP1.S-000001.00']").fill(tampered);
  await sp.locator("button:has-text('Réceptionner')").click();
  await sp.locator("[role=alert]:has-text('illisible')").waitFor();
  await sp.locator("input[placeholder='SP1.S-000001.00']").fill(payload);
  await sp.locator("button:has-text('Réceptionner')").click();
  await sp.locator(".badge:has-text('Reçu')").waitFor();

  // Résultat : drapeau « Haut » ; validation technique par le technicien ; pas de validation biologique pour lui.
  await sp.locator("input[aria-label='Résultat GLY']").fill("7.2");
  await sp.locator("button:has-text('Enregistrer le résultat')").click();
  await sp.locator(".flag:has-text('Haut')").waitFor();
  assert.equal(
    await sp.locator("button:has-text('Validation biologique')").count(),
    0,
    "le technicien n'a pas la validation biologique",
  );
  await sp.locator("button:has-text('Validation technique')").click();
  await sp.locator("text=Validé techniquement").waitFor();
  await shot(lab, "11-labo-validation-technique");
  assert.deepEqual(
    (await api("dev-doctor", `/api/lab/patients/${patient.id}/results`)).data.results,
    [],
    "le médecin ne voit rien avant la validation biologique",
  );

  // Biologiste : validation biologique, puis le médecin voit le résultat validé.
  const bio = await login(browser, "dev-biologist");
  const bsp = bio.locator(`[data-specimen='${specimenNumber}']`);
  await bsp.waitFor();
  await bsp.locator("button:has-text('Validation biologique')").click();
  // Entièrement validé : l'échantillon sort de la liste de travail.
  await bsp.waitFor({ state: "detached" });
  const seen = (await api("dev-doctor", `/api/lab/patients/${patient.id}/results`)).data.results;
  assert.deepEqual([seen[0].value, seen[0].flag, seen[0].status], [7.2, "high", "validated"]);

  /* ------------------------------------------------------------ pharmacie */
  const p2 = await newPatient("Pharma");
  const adm2 = await admit(p2.id);
  const cons = (
    await api("dev-doctor", "/api/consultations", {
      method: "POST",
      body: { patientId: p2.id, encounterId: adm2.encounter.id },
      expect: 201,
    })
  ).data;
  await api("dev-doctor", `/api/patients/${p2.id}/allergies`, {
    method: "POST",
    body: { substanceClass: "penicillin", label: "pénicilline", severity: "severe" },
    expect: 201,
  });
  const lines = [
    { drugCode: PAR, dose: 1, perDay: 3, days: 3, route: "oral" },
    { drugCode: AMO, dose: 1, perDay: 3, days: 5, route: "oral" },
  ];
  const first = await api("dev-doctor", "/api/prescriptions", {
    method: "POST",
    body: { patientId: p2.id, consultationId: cons.id, lines, overrides: [] },
  });
  assert.equal(first.status, 409);
  const key = first.data.error.details.alerts[0].key;
  const rx = (
    await api("dev-doctor", "/api/prescriptions", {
      method: "POST",
      body: {
        patientId: p2.id,
        consultationId: cons.id,
        lines,
        overrides: [{ key, justification: "Allergie ancienne, tolérance testée en service." }],
      },
      expect: 201,
    })
  ).data;
  const expires = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  const receipt = (drugCode, lotNumber, quantity) =>
    api("dev-pharmacy", "/api/stock/receipts", {
      method: "POST",
      body: {
        depot: "PC",
        lines: [{ itemCode: drugCode, lotNumber, expiresOn: expires, quantity }],
      },
    });
  const lotSuffix = suffix;
  assert.equal((await receipt(PAR, `PAR-${lotSuffix}`, 100)).status, 201);
  assert.equal((await receipt(AMO, `AMO-${lotSuffix}`, 10)).status, 201);
  await api("dev-pharmacy", `/api/stock/thresholds/${PAR}`, {
    method: "PUT",
    body: { minimum: 10000 },
    expect: 200,
  });

  const ph = await login(browser, "dev-pharmacy");
  await ph.locator(`button[data-rx='${rx.number}']`).click();
  const disp = ph.locator(`[data-dispense='${rx.number}']`);
  await disp.waitFor();
  await disp.locator("text=Allergies connues : pénicilline").waitFor();
  await disp.locator("text=/Allergie ancienne, tolérance/").waitFor();
  assert.equal(await disp.locator(`tr[data-line='${AMO}'] td`).nth(3).textContent(), "15");
  await shot(ph, "12-pharmacie-delivrance");

  // Stock insuffisant pour l'amoxicilline (10 sur 15) : refusé, rien n'est délivré.
  await disp.locator("button:has-text('Délivrer')").click();
  await disp.locator("[role=alert]:has-text('Stock insuffisant')").waitFor();
  assert.equal(
    (await api("dev-pharmacy", `/api/pharmacy/prescriptions/${rx.id}`)).data.status,
    "pending",
  );

  // Délivrance partielle : 10 d'amoxicilline.
  await disp.locator(`input[aria-label='Quantité à servir ${AMO}']`).fill("10");
  await disp.locator("button:has-text('Délivrer')").click();
  await ph.locator("[role=status]:has-text('partiellement servie')").waitFor();
  await ph.locator(`button[data-rx='${rx.number}']:has-text('partiellement servie')`).waitFor();
  assert.equal(await disp.locator(`tr[data-line='${AMO}'] td`).nth(3).textContent(), "5");
  assert.equal(await disp.locator(`tr[data-line='${PAR}'] td`).nth(3).textContent(), "0");

  // QR de l'ordonnance : le code saisi ouvre la bonne ordonnance.
  const printed = (await api("dev-pharmacy", `/api/prescriptions/${rx.id}/print`, { expect: 200 }))
    .data;
  await ph.fill("input[placeholder='RX1.P-000001.00']", printed.payload);
  await ph.click("button:has-text('Vérifier')");
  await disp.waitFor();
  await ph.fill("input[placeholder='RX1.P-000001.00']", "RX1.P-000001.99");
  await ph.click("button:has-text('Vérifier')");
  await ph.locator("[role=alert]:has-text('non valide')").waitFor();

  // Réapprovisionnement puis délivrance du reste.
  assert.equal((await receipt(AMO, `AMO2-${lotSuffix}`, 20)).status, 201);
  await ph.fill("input[placeholder='RX1.P-000001.00']", printed.payload);
  await ph.click("button:has-text('Vérifier')");
  await disp.waitFor();
  await disp.locator("button:has-text('Délivrer')").click();
  await ph.locator("[role=status]:has-text('entièrement servie')").waitFor();

  console.log("OK : laboratoire et pharmacie vérifiés dans le navigateur.");
} finally {
  await browser.close();
}
