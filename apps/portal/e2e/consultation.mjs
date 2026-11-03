// Écran de consultation du médecin, dans un vrai navigateur : dossier, constantes, diagnostics, ordonnance avec
// alertes, demande d'analyse payée à la caisse, valeur critique avec accusé, clôture.
import assert from "node:assert/strict";
import { api, cardPayload, chromium, importCatalogs, login, shot, sleep } from "./lib.mjs";

const until = async (fn, what, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`Délai dépassé : ${what}`);
};

const suffix = String(Date.now()).slice(-6);
const AMO = `ZA${suffix}`;
const PAR = `ZP${suffix}`;

const browser = await chromium.launch();
try {
  await importCatalogs();
  await api("dev-admin", "/api/catalog/drugs/import", {
    method: "POST",
    csv: `code,dci,forme,dosage,libelle_ar,classe_allergie,classe_interaction,responsable,date_maj\n${AMO},Amoxicilline,Gélule,500 mg,أموكسيسيلين,penicillin,,Pharmacien test,2026-11-01\n${PAR},Paracétamol,Comprimé,500 mg,باراسيتامول,,,Pharmacien test,2026-11-01\n`,
    expect: 200,
  });
  await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
  await api("dev-biologist", "/api/lab/tests/GLY/ranges", {
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
    expect: 200,
  });

  // Un patient admis en consultation : il arrive dans la file d'attente.
  const patient = (
    await api("dev-reception", "/api/patients", {
      method: "POST",
      body: {
        givenName: "Consult",
        familyName: `Essai${suffix}`,
        sex: "male",
        birthDate: "1985-03-02",
        phone: `0077${suffix}1`,
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

  const doc = await login(browser, "dev-doctor");
  const row = doc.locator("button.row", { hasText: `Essai${suffix}` });
  await row.waitFor({ timeout: 20000 });
  await row.click();
  await doc.waitForSelector("h2:has-text('Consult')");

  // Allergie ajoutée au dossier : elle s'affiche en alerte.
  await doc.click("summary");
  await doc.fill("input[placeholder='Classe (ex. penicillin)']", "penicillin");
  await doc.fill("input[placeholder='Libellé']", "pénicilline");
  await doc.click("details button:has-text('Ajouter')");
  await doc.locator("[data-allergies]:has-text('pénicilline')").waitFor();

  // Début de consultation et saisie du brouillon.
  await doc.click("button:has-text('Commencer la consultation')");
  const panel = doc.locator("[data-consultation]");
  await panel.waitFor();
  await panel
    .locator("label:has-text('Motif de consultation') textarea")
    .fill("Toux depuis trois jours");
  await panel.locator("label:has-text('Examen clinique') textarea").fill("Auscultation normale");
  await panel.locator("button:has-text('Enregistrer le brouillon')").click();
  await doc.locator("[role=status]:has-text('Brouillon enregistré (version 2)')").waitFor();

  // Modification simultanée : une autre session enregistre entre-temps ; rien n'est écrasé.
  const current = (
    await api("dev-doctor", `/api/encounters/${adm.encounter.id}/consultation`, { expect: 200 })
  ).data;
  await api("dev-doctor", `/api/consultations/${current.id}`, {
    method: "PUT",
    body: { expectedVersion: current.version, notes: "Note ajoutée depuis un autre poste" },
    expect: 200,
  });
  await panel.locator("label:has-text('Notes') textarea").fill("Ma note");
  await panel.locator("button:has-text('Enregistrer le brouillon')").click();
  await doc.locator("[role=alert]:has-text('modifié entre-temps')").waitFor();
  assert.ok(
    (await doc.locator("[role=alert]").first().textContent()).includes(
      "Note ajoutée depuis un autre poste",
    ),
    "la version enregistrée est montrée",
  );
  await doc.click("button:has-text('Garder ma version')");
  await doc.locator("[role=status]:has-text('Brouillon enregistré (version 4)')").waitFor();

  // Constantes : normale, inhabituelle (confirmation), impossible (refusée).
  const vital = async (kind, value) => {
    await panel.locator("select[aria-label='Mesure']").selectOption(kind);
    await panel.locator("input[aria-label='Valeur']").fill(String(value));
    await panel.locator("button:has-text('Ajouter')").first().click();
  };
  await vital("temperature", 38.5);
  await panel.locator("[data-vitals] li:has-text('38.5')").waitFor();
  await vital("temperature", 42);
  await doc.locator("button:has-text('je confirme la mesure')").click();
  await panel.locator("[data-vitals] li:has-text('42')").waitFor();
  await vital("temperature", 50);
  await panel.locator("[role=alert].error, p.error").first().waitFor();

  // Diagnostic CIM-10 : recherche sans accents.
  await panel.locator("input[aria-label='Chercher un diagnostic (code ou mot)']").fill("diabete");
  await panel.locator("button.row:has-text('E11')").click();
  await panel.locator("[data-diagnoses] li:has-text('E11')").waitFor();
  await panel.locator("[data-diagnoses] .badge:has-text('principal')").waitFor();

  // Ordonnance : alerte d'allergie bloquante tant que le médecin ne la justifie pas par écrit.
  const rx = panel.locator("[data-prescription]");
  await rx.locator("input[aria-label='Chercher un médicament (DCI)']").fill("amoxicilline");
  await rx
    .locator("button.row", { hasText: AMO.length ? "Amoxicilline" : "" })
    .first()
    .click();
  await rx.locator("button:has-text('Signer l\\'ordonnance')").click();
  await rx.locator("[data-alert='allergy']").waitFor();
  await rx.locator("[role=alert].error, p.error").first().waitFor();
  await shot(doc, "20-consultation-alerte");
  await rx
    .locator("[data-alert='allergy'] textarea")
    .fill("Allergie ancienne, tolérance vérifiée en service.");
  const [popup] = await Promise.all([
    doc.waitForEvent("popup"),
    rx.locator("button:has-text('Signer l\\'ordonnance')").click(),
  ]);
  await doc.locator("[role=status]:has-text('signée')").waitFor();
  await popup.waitForLoadState();
  assert.ok((await popup.content()).includes("Ordonnance"), "ordonnance imprimable ouverte");
  await popup.close();
  const prescriptions = (
    await api("dev-pharmacy", `/api/prescriptions?patientId=${patient.id}`, { expect: 200 })
  ).data.prescriptions;
  assert.equal(prescriptions.length, 1);
  const full = (
    await api("dev-doctor", `/api/prescriptions/${prescriptions[0].id}`, { expect: 200 })
  ).data;
  assert.equal(
    full.overrides[0].justification,
    "Allergie ancienne, tolérance vérifiée en service.",
  );

  // Demande d'analyse : payée à la caisse avant exécution, puis valeur critique avec accusé de réception.
  await doc.click("label:has-text('Glycémie') input");
  await doc.click("button:has-text('Envoyer à la caisse')");
  const sent = await doc.waitForSelector("[role=status]:has-text('envoyée à la caisse')");
  const orderNumber = (await sent.textContent()).match(/O-\d{6}/)[0];
  const inv = await until(
    async () =>
      (await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${orderNumber}`))
        .data.invoices[0],
    "facture de la demande",
  );
  await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
    method: "POST",
    body: { method: "cash", receivedAmount: 100000 },
    expect: 200,
  });
  const request = await until(
    async () =>
      (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests[0],
    "demande du laboratoire",
  );
  const sp = (
    await api("dev-lab", `/api/lab/requests/${request.id}/collect`, {
      method: "POST",
      body: { patientScan: await cardPayload(patient.id), specimenType: "Sérum" },
      expect: 201,
    })
  ).data;
  await api("dev-lab", "/api/lab/specimens/receive", {
    method: "POST",
    body: { scan: sp.payload },
    expect: 200,
  });
  await api("dev-lab", `/api/lab/specimens/${sp.id}/results`, {
    method: "POST",
    body: { testCode: "GLY", value: 30 },
    expect: 201,
  });

  const note = doc.locator("[data-notification='critical']");
  await note.waitFor({ timeout: 20000 });
  assert.match(await note.textContent(), /Glycémie = 30/);
  await shot(doc, "21-valeur-critique");
  assert.equal(
    await doc.locator("[data-results]").count(),
    0,
    "le médecin ne voit pas un résultat non validé",
  );
  await api("dev-lab", `/api/lab/specimens/${sp.id}/validate-technical`, {
    method: "POST",
    expect: 200,
  });
  await api("dev-biologist", `/api/lab/specimens/${sp.id}/validate-biological`, {
    method: "POST",
    expect: 200,
  });
  const results = doc.locator("[data-results]");
  await results.waitFor({ timeout: 20000 });
  assert.ok((await results.textContent()).includes("CRITIQUE haut"));
  await note.locator("button:has-text('Accusé de réception')").click();
  await note.waitFor({ state: "detached" });

  // Urgence vitale : le médecin justifie par écrit ; le service d'imagerie reçoit son ticket avant le paiement.
  await doc.click("label:has-text('Radiographie') input");
  await doc.locator("[data-emergency]").check();
  await doc.locator("button:has-text('Envoyer à la caisse')").waitFor();
  assert.equal(
    await doc.locator("button:has-text('Envoyer à la caisse')").isDisabled(),
    true,
    "justification obligatoire",
  );
  await doc
    .locator("label:has-text('Justification écrite obligatoire') textarea")
    .fill("Traumatisme thoracique grave, radiographie immédiate");
  await doc.click("button:has-text('Envoyer à la caisse')");
  const urgent = await doc.waitForSelector("[role=status]:has-text('URGENCE')");
  const urgentNumber = (await urgent.textContent()).match(/O-\d{6}/)[0];
  const urgentOrder = (
    await api("dev-doctor", `/api/service-orders?patientId=${patient.id}`, { expect: 200 })
  ).data.orders.find((o) => o.number === urgentNumber);
  assert.equal(urgentOrder.status, "released", "libérée avant paiement");
  assert.equal(urgentOrder.emergency, true);
  await until(
    async () =>
      (await api("dev-imaging", `/api/imaging/requests?patientId=${patient.id}`)).data.requests
        .length === 1,
    "examen d'imagerie créé sans attendre le paiement",
  );

  // Clôture : impossible sans diagnostic (déjà posé ici), puis plus aucune modification.
  await panel.locator("button:has-text('Clôturer la consultation')").click();
  await doc.locator("[role=status]:has-text('clôturée')").waitFor();
  await panel.locator("label:has-text('Motif de consultation') textarea[disabled]").waitFor();
  assert.equal(await panel.locator("[data-prescription]").count(), 0);
  const closed = (
    await api("dev-doctor", `/api/encounters/${adm.encounter.id}/consultation`, { expect: 200 })
  ).data;
  assert.equal(closed.status, "closed");
  assert.equal(closed.diagnoses[0].code, "E11");
  await shot(doc, "22-consultation-cloturee");

  console.log("OK : consultation du médecin vérifiée dans le navigateur.");
} finally {
  await browser.close();
}
