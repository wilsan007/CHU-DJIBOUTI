// Écrans hospitalisation et imagerie, dans un vrai navigateur : séjour payé d'abord, entrée au lit, soins, acte lourd,
// sortie et facture finale ; examen d'imagerie programmé, réalisé, image téléversée, compte rendu lu par le médecin.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { api, chromium, importCatalogs, login, shot, sleep, ACTS_CSV } from "./lib.mjs";

const EXTRA = `HOSP-1J,Hospitalisation par jour,إيواء ليوم واحد,10000,HOSP,hospitalisation,Responsable test,2026-11-01
HOSP-SOIN,Soins infirmiers du jour,رعاية تمريضية يومية,2000,HOSP,hospitalisation,Responsable test,2026-11-01
CHIR-INI,Opération initiale (exemple),عملية أولية,50000,HOSP,autre,Responsable test,2026-11-01
CHIR-GRD,Grande opération en cours de séjour (exemple),عملية كبرى,80000,HOSP,autre,Responsable test,2026-11-01
`;
const suffix = String(Date.now()).slice(-6);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const newPatient = async (name) => {
  const patient = (
    await api("dev-reception", "/api/patients", {
      method: "POST",
      body: {
        givenName: name,
        familyName: `Essai${suffix}`,
        sex: "female",
        birthDate: "1979-05-09",
        phone: `0077${suffix}${name.length}`,
        confirmNotDuplicate: true,
      },
      expect: 201,
    })
  ).data;
  const adm = (
    await api("dev-reception", "/api/admissions", {
      method: "POST",
      body: {
        patientId: patient.id,
        departmentCode: "CONS",
        payerCode: "DIRECT",
        actCode: "CONS-GEN",
      },
      expect: 201,
    })
  ).data;
  return { patient, adm };
};
const payOrder = async (orderNumber) => {
  let inv;
  for (let i = 0; i < 40 && !inv; i += 1) {
    inv = (
      await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${orderNumber}`, {
        expect: 200,
      })
    ).data.invoices[0];
    if (!inv) await sleep(500);
  }
  assert.ok(inv, `facture de ${orderNumber}`);
  await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
    method: "POST",
    body: { method: "cash", receivedAmount: 1_000_000 },
    expect: 200,
  });
  return inv;
};

const browser = await chromium.launch();
try {
  await importCatalogs();
  await api("dev-admin", "/api/catalog/acts/import", {
    method: "POST",
    csv: ACTS_CSV + EXTRA,
    expect: 200,
  });
  await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });

  // ---------- Hospitalisation ----------
  await newPatient("Hospi");
  const doc = await login(browser, "dev-doctor");
  await doc.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
  await doc.click("[data-tab='new']");
  const optionValue = await doc
    .locator('select[aria-label="Patient de la file d\'attente"] option', {
      hasText: `Essai${suffix}`,
    })
    .first()
    .getAttribute("value");
  await doc.selectOption('select[aria-label="Patient de la file d\'attente"]', optionValue);
  await doc.locator("label:has-text('Opération initiale')").click();
  await doc.click("button:has-text('Envoyer le forfait à la caisse')");
  const panel = doc.locator("[data-stay-panel]");
  await panel.waitFor();
  await panel
    .locator("[data-orders] [data-order-status='pending'], [data-orders] li")
    .first()
    .waitFor();
  await shot(doc, "hosp-1-awaiting");
  const stayNumber = await panel.getAttribute("data-stay-panel");

  // Le médecin ne peut pas admettre au lit ; l'infirmier non plus tant que ce n'est pas payé.
  assert.equal(
    await panel.locator("button:has-text('Admettre au lit')").count(),
    0,
    "médecin sans admission",
  );
  const stay = (await api("dev-doctor", "/api/stays", { expect: 200 })).data.stays.find(
    (s) => s.number === stayNumber,
  );
  const detail = (await api("dev-doctor", `/api/stays/${stay.id}`, { expect: 200 })).data;
  const order = detail.orders[0];
  await payOrder(order.number);

  const nurse = await login(browser, "dev-nurse");
  await nurse.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
  await nurse.click(`[data-stay='${stayNumber}']`);
  const np = nurse.locator("[data-stay-panel]");
  await nurse.reload();
  await nurse.waitForSelector(".shell");
  await nurse.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
  await nurse.click(`[data-stay='${stayNumber}']`);
  await np.locator("select[aria-label='Lit']").waitFor();
  await np.locator("select[aria-label='Lit']").selectOption({ index: 1 });
  await np.locator("button:has-text('Admettre au lit')").click();
  await np.locator("[data-projected]").waitFor();
  await shot(nurse, "hosp-2-admitted");

  // Lits : le lit est occupé.
  await nurse.click("[data-tab='beds']");
  await nurse.locator(`[data-bed][data-occupied='true']:has-text('Essai${suffix}')`).waitFor();
  await shot(nurse, "hosp-3-beds");
  await nurse.click("[data-tab='stays']");
  await nurse.click(`[data-stay='${stayNumber}']`);

  // Soin courant et acte lourd payé à part.
  await np.locator("select[aria-label='Soin courant']").selectOption("HOSP-SOIN");
  await np.locator("button:has-text('Ajouter le soin')").click();
  await np.locator("[data-charges] li:has-text('HOSP-SOIN')").waitFor();
  await np.locator("select[aria-label^='Demander un acte lourd']").selectOption("CHIR-GRD");
  await np.locator("button:has-text('Demander un acte lourd')").click();
  await np.locator("[role=status]").waitFor();
  const stayNow = (await api("dev-nurse", `/api/stays/${stay.id}`, { expect: 200 })).data;
  const heavy = stayNow.orders.find((o) => o.id !== order.id);
  assert.ok(heavy, "l'acte lourd a sa propre commande");
  assert.notEqual(heavy.status, "released", "acte lourd non libéré tant que non payé");
  await payOrder(heavy.number);

  // Sortie : ordre du médecin, facture finale, paiement, sortie enregistrée.
  const doc2 = doc;
  await doc2.click("[data-tab='stays']");
  await doc2.click(`[data-stay='${stayNumber}']`);
  await doc2.locator("button:has-text('Ordonner la sortie')").click();
  await doc2.locator("[data-final-invoice]").waitFor();
  await shot(doc2, "hosp-4-discharge");
  const fin = (await api("dev-doctor", `/api/stays/${stay.id}`, { expect: 200 })).data;
  assert.ok(fin.finalInvoiceId, "facture finale");
  await nurse.click("[data-tab='stays']");
  await nurse.click(`[data-stay='${stayNumber}']`);
  // sortie refusée avant paiement
  await nurse.locator("button:has-text('Enregistrer la sortie du patient')").click();
  await nurse.locator("[role=alert], .error").first().waitFor();
  await api("dev-cashier", `/api/billing/invoices/${fin.finalInvoiceId}/pay`, {
    method: "POST",
    body: { method: "cash", receivedAmount: 1_000_000 },
    expect: 200,
  });
  await nurse.locator("button:has-text('Enregistrer la sortie du patient')").click();
  await nurse.locator("[role=status]").waitFor();
  assert.equal(
    (await api("dev-nurse", `/api/stays/${stay.id}`, { expect: 200 })).data.status,
    "discharged",
  );
  await shot(nurse, "hosp-5-exit");

  // ---------- Imagerie ----------
  const b = await newPatient("Radio");
  const ord = (
    await api("dev-doctor", "/api/service-orders", {
      method: "POST",
      body: {
        patientId: b.patient.id,
        encounterId: b.adm.encounter.id,
        items: [{ actCode: "IMG-RX", quantity: 1 }],
      },
      expect: 201,
    })
  ).data;
  const tech = await login(browser, "dev-imaging");
  await tech.waitForSelector("nav[aria-label='principal']");
  await tech.click("nav[aria-label='principal'] button:has-text('Imagerie')").catch(() => {});
  await sleep(1500);
  assert.equal(
    await tech.locator(`[data-exam]:has-text('Essai${suffix}')`).count(),
    0,
    "rien avant paiement",
  );
  await payOrder(ord.number);
  const card = tech.locator(`[data-exam]:has-text('Essai${suffix}')`);
  await card.waitFor({ timeout: 20000 });
  await card.locator("input[type='datetime-local']").fill("2026-11-10T09:30");
  await card.locator("button:has-text('Programmer')").click();
  await card.locator(".badge:has-text('Programmé'), .badge:has-text('programm')").first().waitFor();
  await card.locator('button:has-text("Commencer l\'examen")').click();
  await card.locator("[data-image-count]").waitFor();
  const png = `/tmp/chu-e2e-${suffix}.png`;
  writeFileSync(png, PNG);
  await card.locator("input[type='file']").setInputFiles(png);
  await card.locator("[data-image-count]:has-text('1')").waitFor();
  await card
    .locator("label:has-text('Description') textarea")
    .fill("Pas de lésion osseuse visible (exemple de test).");
  await card
    .locator("label:has-text('Conclusion') textarea")
    .fill("Examen sans anomalie (exemple).");
  await shot(tech, "imaging-1-report");
  await card.locator("button:has-text('Enregistrer le compte rendu')").click();
  await tech
    .locator(`[data-exam]:has-text('Essai${suffix}')`)
    .waitFor({ state: "detached", timeout: 15000 });

  const reqs = (
    await api("dev-doctor", `/api/imaging/requests?patientId=${b.patient.id}`, { expect: 200 })
  ).data.requests;
  assert.equal(reqs[0].status, "reported");
  const full = (await api("dev-doctor", `/api/imaging/requests/${reqs[0].id}`, { expect: 200 }))
    .data;
  assert.equal(full.images.length, 1);
  // Le médecin lit le compte rendu dans le dossier du patient (lecture seule).
  await doc.click("nav[aria-label='principal'] button:has-text('Médecin')");
  await doc.locator("button.row", { hasText: `Radio Essai${suffix}` }).click();
  const rep = doc.locator("[data-imaging-report]");
  await rep.waitFor({ timeout: 15000 });
  assert.ok((await rep.textContent()).includes("Examen sans anomalie"));
  const [popup] = await Promise.all([
    doc.context().waitForEvent("page"),
    rep.locator("button", { hasText: "Ouvrir l'image" }).click(),
  ]);
  await popup.waitForLoadState();
  assert.ok(popup.url().startsWith("blob:"), "image ouverte depuis le compte rendu");
  await shot(doc, "imaging-2-doctor");
  console.log("OK hospitalisation + imagerie");
} finally {
  await browser.close();
}
