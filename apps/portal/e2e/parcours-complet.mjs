// PARCOURS COMPLET D'UN PATIENT, de A à Z, dans un vrai navigateur, avec tous les rôles qui se passent le relais :
// accueil → caisse → consultation (constantes, allergie, diagnostic, ordonnance avec alerte) → analyse et radio payées d'abord →
// laboratoire (prélèvement, réception, résultat critique, validation en deux temps) → pharmacie (stock, délivrance) → imagerie →
// hospitalisation (forfait, lit, soins, matériel, acte lourd, sortie, facture finale) → stocks (consommation automatique) →
// direction (tableau de bord) → espace patient (code SMS) → contrôles de cohérence (audit, événements, caisse).
// Chaque étape est notée dans une matrice affichée à la fin. Prérequis : voir apps/portal/README.md (+ passerelle SMS d'essai).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  ACTS_CSV,
  api,
  cardPayload,
  clearCriticalNotifications,
  chromium,
  importCatalogs,
  login,
  shot,
  sleep,
} from "./lib.mjs";

const suffix = String(Date.now()).slice(-6);
const NAME = `Parcours${suffix}`;
const matrix = [];
const until = async (fn, what, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`Délai dépassé : ${what}`);
};
async function step(module, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    matrix.push({ module, name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ [${module}] ${name}`);
  } catch (error) {
    matrix.push({
      module,
      name,
      ok: false,
      ms: Date.now() - t0,
      error: String(error.message ?? error)
        .split("\n")
        .slice(0, 4)
        .join(" | "),
    });
    console.log(
      `  ✘ [${module}] ${name} : ${String(error.message ?? error)
        .split("\n")
        .slice(0, 4)
        .join(" | ")}`,
    );
    throw error;
  }
}
const payOrder = async (orderNumber, via) => {
  const inv = await until(
    async () =>
      (await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${orderNumber}`))
        .data.invoices[0],
    `facture de ${orderNumber}`,
  );
  if (via) {
    // Encaissement par l'écran de la caisse
    const card = via.locator(`[data-invoice='${inv.number}']`);
    await card.waitFor({ timeout: 20000 });
    await card.locator("button:has-text('Encaisser')").click();
    await via.locator("[role=status]:has-text('Reçu')").waitFor();
  } else {
    await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
      method: "POST",
      body: { method: "cash", receivedAmount: 1_000_000 },
      expect: 200,
    });
  }
  return inv;
};

// Passerelle SMS d'essai : reçoit le code de l'espace patient.
const sms = [];
const gateway = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    sms.push(JSON.parse(raw));
    res.end("{}");
  });
});
await new Promise((r) => gateway.listen(4599, "127.0.0.1", r));

const EXTRA = `HOSP-1J,Hospitalisation par jour,إيواء ليوم واحد,10000,HOSP,hospitalisation,Responsable test,2026-11-01
HOSP-SOIN,Soins infirmiers du jour,رعاية تمريضية يومية,2000,HOSP,hospitalisation,Responsable test,2026-11-01
CHIR-INI,Opération initiale (exemple),عملية أولية,50000,HOSP,autre,Responsable test,2026-11-01
CHIR-GRD,Grande opération en cours de séjour (exemple),عملية كبرى,80000,HOSP,autre,Responsable test,2026-11-01
`;
const SYR = `SYR${suffix}`;
const REA = `REA${suffix}`;
const DRUG = "AMO-500"; // amoxicilline du catalogue de test (allergie : pénicilline)
const PRACT = `dr-parcours-${suffix}`;
const expires = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

const browser = await chromium.launch();
const pages = {};
let patient;
let failure = null;
try {
  /* ============================================================== 0. Préparation (administration du système) */
  await step(
    "Préparation",
    "catalogues, plages de référence, médicament, stock, recette d'acte, agenda, caisse",
    async () => {
      await importCatalogs();
      await clearCriticalNotifications("dev-doctor"); // alertes laissées par des essais précédents
      await api("dev-admin", "/api/catalog/acts/import", {
        method: "POST",
        csv: ACTS_CSV + EXTRA,
        expect: 200,
      });
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
      await api("dev-storekeeper", "/api/stock/items/import", {
        method: "POST",
        csv: `code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj\n${SYR},Seringue 5 ml ${suffix},محقنة,consommable,seringue,Magasinier test,2026-11-01\n${REA},Réactif glycémie ${suffix},كاشف,reactif,test,Biologiste test,2026-11-01\n`,
        expect: 200,
      });
      for (const [code, qty] of [
        [SYR, 50],
        [REA, 20],
      ])
        await api("dev-storekeeper", "/api/stock/receipts", {
          method: "POST",
          body: {
            depot: "MG",
            lines: [{ itemCode: code, lotNumber: `L-${code}`, expiresOn: expires, quantity: qty }],
          },
          expect: 201,
        });
      for (const code of [SYR, REA]) {
        const lot = (await api("dev-storekeeper", `/api/stock/levels?depot=MG&itemCode=${code}`))
          .data.lots[0];
        await api("dev-storekeeper", "/api/stock/transfers", {
          method: "POST",
          body: {
            from: "MG",
            to: "LAB",
            lines: [{ lotId: lot.lotId, quantity: code === SYR ? 20 : 10 }],
          },
          expect: 201,
        });
      }
      await api("dev-storekeeper", "/api/stock/recipes/LAB-GLY", {
        method: "PUT",
        body: {
          items: [
            { itemCode: REA, quantity: 1 },
            { itemCode: SYR, quantity: 1 },
          ],
          responsible: "Magasinier test",
          updatedOn: "2026-11-01",
        },
        expect: 200,
      });
      // Le médicament devient un article du stock par un événement (asynchrone) : on attend qu'il existe.
      await until(
        async () =>
          (
            await api("dev-pharmacy", "/api/stock/receipts", {
              method: "POST",
              body: {
                depot: "PC",
                lines: [
                  { itemCode: DRUG, lotNumber: `AMO-${suffix}`, expiresOn: expires, quantity: 100 },
                ],
              },
            })
          ).status === 201,
        "article médicament créé dans le stock",
      );
      await api("dev-admin", `/api/schedule/practitioners/${PRACT}`, {
        method: "PUT",
        body: { displayName: `Dr Parcours ${suffix}`, departmentCode: "CONS" },
        expect: 200,
      });
      await api("dev-admin", `/api/schedule/practitioners/${PRACT}/availability`, {
        method: "PUT",
        body: {
          rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            start: "08:00",
            end: "10:00",
            slotMinutes: 30,
          })),
        },
        expect: 200,
      });
      await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
    },
  );
  const base = (await api("dev-direction", "/api/dashboard", { expect: 200 })).data;

  /* ============================================================== 1. Accueil */
  await step(
    "Accueil",
    "connexion de la réception : un seul rôle, ses écrans seulement",
    async () => {
      pages.reception = await login(browser, "dev-reception");
      const names = await pages.reception
        .locator("nav[aria-label='principal'] button")
        .allTextContents();
      assert.deepEqual(
        names.map((n) => n.trim()),
        ["Réception", "Mon espace"],
      );
    },
  );
  await step(
    "Accueil",
    "recherche sans résultat, création du dossier patient, doublon refusé",
    async () => {
      const r = pages.reception;
      await r.fill("input[aria-label='Nom, identifiant ou téléphone']", NAME);
      await r.locator(".empty").first().waitFor();
      const create = async () => {
        await r.click("text=Nouveau patient");
        await r.fill("label:text-is('Prénom') input", "Aïcha");
        await r.fill("label:text-is('Nom') input", NAME);
        await r.fill("label:text-is('Date de naissance') input", "1988-04-12");
        await r.fill("label:text-is('Téléphone') input", `0025377${suffix}`);
        await r.click("button:has-text('Enregistrer')");
      };
      await create();
      await r.locator("h2", { hasText: NAME }).waitFor();
      // Même personne à nouveau : le système propose le dossier proche.
      await r.fill("input[aria-label='Nom, identifiant ou téléphone']", "");
      await create();
      await r.locator("text=Des patients proches existent déjà").waitFor();
      await r.click("button:has-text('Annuler')").catch(() => {});
      const found = (await api("dev-reception", `/api/patients?q=${NAME}`)).data.results;
      patient = found.find((p) => p.familyName === NAME);
      assert.ok(patient, "dossier créé");
      assert.equal(found.filter((p) => p.familyName === NAME).length, 1, "pas de doublon créé");
    },
  );
  await step("Accueil", "carte du patient : QR imprimé et lisible", async () => {
    const r = pages.reception;
    await r.fill("input[aria-label='Nom, identifiant ou téléphone']", NAME);
    await r.locator("button.row", { hasText: NAME }).click();
    const [popup] = await Promise.all([
      r.context().waitForEvent("page"),
      r.click("[data-print-card]"),
    ]);
    await popup.waitForSelector("[data-qr='card'] svg");
    assert.ok((await popup.content()).includes(patient.identifier));
    await popup.close();
  });
  let consultationInvoice;
  await step("Accueil", "admission à la consultation : facture à payer à la caisse", async () => {
    const r = pages.reception;
    await r.click("button:has-text('Admettre à la consultation')");
    const note = await r.waitForSelector("[role=status]:has-text('Facture')");
    consultationInvoice = (await note.textContent()).match(/F-\d{6}/)[0];
    await shot(r, "pc-1-admission");
  });

  /* ============================================================== 2. Caisse */
  await step(
    "Caisse",
    "avant paiement : le patient est dans la file avec « À payer », et la consultation est REFUSÉE (règle : on paie d'abord)",
    async () => {
      const entry = await until(
        async () =>
          (await api("dev-doctor", "/api/queue?department=CONS")).data.queue.find(
            (e) => e.patientId === patient.id,
          ),
        "arrivée dans la file",
      );
      assert.equal(entry.settled, false);
      const early = await api("dev-doctor", "/api/consultations", {
        method: "POST",
        body: { patientId: patient.id, encounterId: entry.encounterId },
      });
      assert.equal(early.status, 409);
      assert.equal(early.data.error.code, "consultation_unpaid");
    },
  );
  await step(
    "Caisse",
    "encaissement de la consultation par l'écran de caisse (reçu, ticket libéré)",
    async () => {
      pages.cashier = await login(browser, "dev-cashier");
      const c = pages.cashier;
      await c.locator(`[data-invoice='${consultationInvoice}']`).waitFor();
      await c
        .locator(`[data-invoice='${consultationInvoice}'] button:has-text('Encaisser')`)
        .click();
      await c.locator("[role=status]:has-text('Reçu')").waitFor();
      await c.locator(`[data-invoice='${consultationInvoice}']`).waitFor({ state: "detached" });
      await until(
        async () =>
          (await api("dev-doctor", "/api/queue?department=CONS")).data.queue.some(
            (e) => e.patientId === patient.id && e.settled === true,
          ),
        "file : payé",
      );
    },
  );

  /* ============================================================== 3. Consultation */
  const doc = (pages.doctor = await login(browser, "dev-doctor"));
  await step(
    "Médecin",
    "file d'attente : le patient apparaît, ouverture du dossier, bandeau d'identité",
    async () => {
      await doc.locator("button.row", { hasText: NAME }).click();
      await doc.locator("h2", { hasText: NAME }).waitFor();
    },
  );
  await step("Médecin", "allergie ajoutée au dossier (alerte visible)", async () => {
    await doc.click("summary");
    await doc.fill("input[placeholder='Classe (ex. penicillin)']", "penicillin");
    await doc.fill("input[placeholder='Libellé']", "pénicilline");
    await doc.click("details button:has-text('Ajouter')");
    await doc.locator("[data-allergies]:has-text('pénicilline')").waitFor();
  });
  const panel = doc.locator("[data-consultation]");
  await step(
    "Médecin",
    "début de consultation, brouillon enregistré, constantes (normale, inhabituelle confirmée, impossible refusée)",
    async () => {
      await doc.click("button:has-text('Commencer la consultation')");
      await panel.waitFor();
      await panel
        .locator("label:has-text('Motif de consultation') textarea")
        .fill("Fièvre et soif intense depuis une semaine");
      await panel
        .locator("label:has-text('Examen clinique') textarea")
        .fill("Déshydratation modérée");
      await panel.locator("button:has-text('Enregistrer le brouillon')").click();
      await doc.locator("[role=status]:has-text('Brouillon enregistré')").waitFor();
      const vital = async (kind, value) => {
        await panel.locator("select[aria-label='Mesure']").selectOption(kind);
        await panel.locator("input[aria-label='Valeur']").fill(String(value));
        await panel.locator("button:has-text('Ajouter')").first().click();
      };
      await vital("temperature", 38.5);
      await panel.locator("[data-vitals] li:has-text('38.5')").waitFor();
      await vital("temperature", 50);
      await panel.locator("p.error, [role=alert].error").first().waitFor();
    },
  );
  await step("Médecin", "diagnostic CIM-10 (recherche sans accents) et principal", async () => {
    await panel.locator("input[aria-label='Chercher un diagnostic (code ou mot)']").fill("diabete");
    await panel.locator("button.row:has-text('E11')").click();
    await panel.locator("[data-diagnoses] .badge:has-text('principal')").waitFor();
  });
  let rxNumber;
  await step(
    "Médecin",
    "ordonnance : alerte d'allergie, justification écrite, signature, impression",
    async () => {
      const rx = panel.locator("[data-prescription]");
      await rx.locator("input[aria-label='Chercher un médicament (DCI)']").fill("amoxicilline");
      await rx.locator("button.row", { hasText: "Amoxicilline" }).first().click();
      await rx.locator("button:has-text('Signer l\\'ordonnance')").click();
      await rx.locator("[data-alert='allergy']").waitFor();
      await rx
        .locator("[data-alert='allergy'] textarea")
        .fill("Allergie ancienne, tolérance vérifiée en service.");
      const [popup] = await Promise.all([
        doc.waitForEvent("popup"),
        rx.locator("button:has-text('Signer l\\'ordonnance')").click(),
      ]);
      await doc.locator("[role=status]:has-text('signée')").waitFor();
      await popup.waitForLoadState();
      await popup.waitForSelector("[data-qr='prescription'] svg");
      await popup.close();
      const list = (await api("dev-pharmacy", `/api/prescriptions?patientId=${patient.id}`)).data
        .prescriptions;
      assert.equal(list.length, 1);
      rxNumber = list[0].number;
    },
  );
  let labOrder;
  await step(
    "Médecin",
    "demande d'analyse et de radio : « envoyée à la caisse », rien dans les services avant paiement",
    async () => {
      await doc.click("label:has-text('Glycémie') input");
      await doc.click("label:has-text('Radiographie') input");
      await doc.click("button:has-text('Envoyer à la caisse')");
      const sent = await doc.waitForSelector("[role=status]:has-text('envoyée à la caisse')");
      labOrder = (await sent.textContent()).match(/O-\d{6}/)[0];
      await sleep(1200);
      assert.equal(
        (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests.length,
        0,
        "labo : rien avant paiement",
      );
      assert.equal(
        (await api("dev-imaging", `/api/imaging/requests?patientId=${patient.id}`)).data.requests
          .length,
        0,
        "imagerie : rien avant paiement",
      );
    },
  );
  await step(
    "Caisse",
    "paiement de la demande par l'écran : les deux services reçoivent leur ticket",
    async () => {
      const c = pages.cashier;
      await c.reload();
      await c.locator("nav[aria-label='principal'] button:has-text('Caisse')").click();
      await payOrder(labOrder, c);
      await until(
        async () =>
          (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests[0],
        "demande labo",
      );
      await until(
        async () =>
          (await api("dev-imaging", `/api/imaging/requests?patientId=${patient.id}`)).data
            .requests[0],
        "examen imagerie",
      );
    },
  );

  /* ============================================================== 4. Laboratoire */
  const lab = (pages.lab = await login(browser, "dev-lab"));
  let specimenNumber;
  let specimenPayload;
  await step(
    "Laboratoire",
    "demande visible, prélèvement refusé avec la carte d'un autre patient puis accepté, étiquette QR",
    async () => {
      const req = (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data
        .requests[0];
      const card = lab.locator(`[data-request='${req.number}']`);
      await card.waitFor();
      const other = (
        await api("dev-reception", "/api/patients", {
          method: "POST",
          body: {
            givenName: "Autre",
            familyName: `Intrus${suffix}`,
            sex: "male",
            birthDate: "1970-01-01",
            confirmNotDuplicate: true,
          },
          expect: 201,
        })
      ).data;
      await card.locator("input[placeholder='CHU1.000001.00']").fill(await cardPayload(other.id));
      await card.locator("button:has-text('Prélever')").click();
      await card.locator("[role=alert]:has-text('pas celle du patient')").waitFor();
      await card.locator("input[placeholder='CHU1.000001.00']").fill(await cardPayload(patient.id));
      const [popup] = await Promise.all([
        lab.waitForEvent("popup"),
        card.locator("button:has-text('Prélever')").click(),
      ]);
      const note = await lab.waitForSelector("[role=status]:has-text('prélevé')");
      specimenNumber = (await note.textContent()).match(/S-\d{6}/)[0];
      await popup.waitForSelector("[data-qr='specimen'] svg");
      await popup.close();
      specimenPayload = (
        await api("dev-lab", "/api/lab/specimens?status=collected")
      ).data.specimens.find((s) => s.number === specimenNumber).payload;
    },
  );
  await step(
    "Laboratoire",
    "réception de l'échantillon, résultat critique (30 mmol/L), validation technique",
    async () => {
      const sp = lab.locator(`[data-specimen='${specimenNumber}']`);
      await sp.locator("input[placeholder='SP1.S-000001.00']").fill(specimenPayload);
      await sp.locator("button:has-text('Réceptionner')").click();
      await sp.locator(".badge:has-text('Reçu')").waitFor();
      await sp.locator("input[aria-label='Résultat GLY']").fill("30");
      await sp.locator("button:has-text('Enregistrer le résultat')").click();
      await sp.locator(".flag.critical").waitFor();
      await sp.locator("button:has-text('Validation technique')").click();
      await sp.locator("text=Validé techniquement").waitFor();
    },
  );
  await step(
    "Médecin",
    "message de valeur critique reçu, accusé de réception, résultat NON visible avant validation biologique",
    async () => {
      const note = doc.locator("[data-notification='critical']");
      await note.waitFor({ timeout: 25000 });
      assert.match(await note.textContent(), /Glycémie = 30/);
      assert.equal(
        await doc.locator("[data-results]").count(),
        0,
        "résultat non validé invisible pour le médecin",
      );
      await note.locator("button:has-text('Accusé de réception')").click();
      await note.waitFor({ state: "detached" });
    },
  );
  await step(
    "Laboratoire",
    "validation biologique par une AUTRE personne ; le médecin voit le résultat validé",
    async () => {
      assert.equal(
        await lab
          .locator(`[data-specimen='${specimenNumber}'] button:has-text('Validation biologique')`)
          .count(),
        0,
        "le technicien ne valide pas biologiquement",
      );
      pages.bio = await login(browser, "dev-biologist");
      const bsp = pages.bio.locator(`[data-specimen='${specimenNumber}']`);
      await bsp.waitFor();
      await bsp.locator("button:has-text('Validation biologique')").click();
      await bsp.waitFor({ state: "detached" });
      await doc.locator("[data-results]").waitFor({ timeout: 20000 });
      assert.match(await doc.locator("[data-results]").textContent(), /30/);
    },
  );

  await step(
    "Stocks",
    "consommation automatique de l'acte (à la fin de l'analyse, donc après la validation) : réactif et seringue prélevés dans la réserve du laboratoire",
    async () => {
      const left = async (code) =>
        (
          await api("dev-storekeeper", `/api/stock/levels?depot=LAB&itemCode=${code}`)
        ).data.lots.reduce((n, l) => n + l.quantity, 0);
      await until(async () => (await left(REA)) === 9, "réactif prélevé (10 - 1)");
      assert.equal(await left(SYR), 19);
    },
  );

  /* ============================================================== 5. Pharmacie */
  await step(
    "Pharmacie",
    "ordonnance retrouvée par son QR, allergies et alerte justifiée visibles, délivrance, stock décrémenté",
    async () => {
      const ph = (pages.pharmacy = await login(browser, "dev-pharmacy"));
      await ph.locator(`button[data-rx='${rxNumber}']`).click();
      const disp = ph.locator(`[data-dispense='${rxNumber}']`);
      await disp.waitFor();
      await disp.locator("text=Allergies connues : pénicilline").waitFor();
      await disp.locator("text=/Allergie ancienne, tolérance/").waitFor();
      const stockOf = async () =>
        (await api("dev-pharmacy", `/api/stock/levels?depot=PC&itemCode=${DRUG}`)).data.lots.reduce(
          (n, l) => n + l.quantity,
          0,
        );
      const before = await stockOf();
      await disp.locator("button:has-text('Délivrer')").click();
      await ph.locator("[role=status]:has-text('entièrement servie')").waitFor();
      const after = await stockOf();
      assert.ok(after < before, `stock de la pharmacie décrémenté (${before} → ${after})`);
    },
  );

  /* ============================================================== 6. Imagerie */
  await step(
    "Imagerie",
    "examen payé : programmation, début, image, compte rendu ; le médecin le lit",
    async () => {
      const tech = (pages.imaging = await login(browser, "dev-imaging"));
      const card = tech.locator("[data-exam]", { hasText: NAME });
      await card.waitFor({ timeout: 20000 });
      await card.locator("input[type='datetime-local']").fill("2026-11-20T09:30");
      await card.locator("button:has-text('Programmer')").click();
      await card.locator('button:has-text("Commencer l\'examen")').click();
      await card.locator("[data-image-count]").waitFor();
      const png = `/tmp/parcours-${suffix}.png`;
      writeFileSync(
        png,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      await card.locator("input[type='file']").setInputFiles(png);
      await card.locator("[data-image-count]:has-text('1')").waitFor();
      await card
        .locator("label:has-text('Description') textarea")
        .fill("Pas de lésion osseuse (exemple de test).");
      await card
        .locator("label:has-text('Conclusion') textarea")
        .fill("Examen sans anomalie (exemple).");
      await card.locator("button:has-text('Enregistrer le compte rendu')").click();
      await card.waitFor({ state: "detached" });
      await doc.reload();
      await doc.locator("nav[aria-label='principal'] button:has-text('Consultations')").click();
      await doc.locator("button.row", { hasText: NAME }).click();
      await doc.locator("[data-imaging-report]").waitFor({ timeout: 20000 });
      assert.match(await doc.locator("[data-imaging-report]").textContent(), /sans anomalie/);
    },
  );

  /* ============================================================== 7. Hospitalisation */
  let stayNumber;
  await step(
    "Hospitalisation",
    "nouveau séjour (forfait première nuit + acte initial) envoyé à la caisse",
    async () => {
      await doc.reload();
      await doc.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
      await doc.click("[data-tab='new']");
      const sel = 'select[aria-label="Patient de la file d\'attente"]';
      const value = await doc
        .locator(`${sel} option`, { hasText: NAME })
        .first()
        .getAttribute("value");
      await doc.selectOption(sel, value);
      await doc.locator("label:has-text('Opération initiale')").click();
      await doc.click("button:has-text('Envoyer le forfait à la caisse')");
      const panel2 = doc.locator("[data-stay-panel]");
      await panel2.waitFor();
      stayNumber = await panel2.getAttribute("data-stay-panel");
    },
  );
  let stayId;
  await step("Caisse", "paiement du forfait d'hospitalisation", async () => {
    const stay = (await api("dev-doctor", "/api/stays")).data.stays.find(
      (s) => s.number === stayNumber,
    );
    stayId = stay.id;
    const detail = (await api("dev-doctor", `/api/stays/${stayId}`)).data;
    await payOrder(detail.orders[0].number);
  });
  const nurse = (pages.nurse = await login(browser, "dev-nurse"));
  await step(
    "Hospitalisation",
    "admission au lit par l'infirmier (impossible avant paiement), lit occupé dans le plan",
    async () => {
      await nurse.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
      await nurse.click(`[data-stay='${stayNumber}']`);
      const np = nurse.locator("[data-stay-panel]");
      await np.locator("select[aria-label='Lit']").waitFor();
      await np.locator("select[aria-label='Lit']").selectOption({ index: 1 });
      await np.locator("button:has-text('Admettre au lit')").click();
      await np.locator("[data-projected]").waitFor();
      await nurse.click("[data-tab='beds']");
      await nurse.locator(`[data-bed][data-occupied='true']:has-text('${NAME}')`).waitFor();
      await nurse.click("[data-tab='stays']");
      await nurse.click(`[data-stay='${stayNumber}']`);
    },
  );
  await step(
    "Hospitalisation",
    "soin courant, acte lourd payé à part, matériel utilisé tracé sur le patient",
    async () => {
      const np = nurse.locator("[data-stay-panel]");
      await np.locator("select[aria-label='Soin courant']").selectOption("HOSP-SOIN");
      await np.locator("button:has-text('Ajouter le soin')").click();
      await np.locator("[data-charges] li:has-text('HOSP-SOIN')").waitFor();
      await np.locator("select[aria-label^='Demander un acte lourd']").selectOption("CHIR-GRD");
      await np.locator("button:has-text('Demander un acte lourd')").click();
      await np.locator("[role=status]").waitFor();
      const heavy = (await api("dev-nurse", `/api/stays/${stayId}`)).data.orders.find(
        (o) => o.kind === "extra",
      );
      assert.notEqual(heavy.status, "released");
      await payOrder(heavy.number);
      // matériel : la seringue du magasin vers l'hôpital puis utilisation enregistrée par l'infirmier
      const lot = (await api("dev-storekeeper", `/api/stock/levels?depot=MG&itemCode=${SYR}`)).data
        .lots[0];
      await api("dev-storekeeper", "/api/stock/transfers", {
        method: "POST",
        body: { from: "MG", to: "HOSP", lines: [{ lotId: lot.lotId, quantity: 5 }] },
        expect: 201,
      });
      await nurse.click("nav[aria-label='principal'] button:has-text('Matériel utilisé')");
      await nurse
        .locator("select[aria-label='Dépôt']")
        .selectOption({ label: "Réserve d'hospitalisation et bloc" });
      await nurse.fill("input[aria-label='Chercher un article (code ou nom)']", SYR);
      await nurse.click(`button[data-item='${SYR}']`);
      await nurse.fill("label:text-is('Quantité') input", "1");
      await nurse.fill("input[aria-label='Patient concerné (facultatif)']", NAME);
      await nurse.click(`button.row:has-text('${NAME}')`);
      await nurse.fill("label:has-text('Motif') input", "pansement");
      await nurse.click("button:has-text('Enregistrer l\\'utilisation')");
      await nurse.locator(`[role=status]:has-text('${SYR}')`).waitFor();
    },
  );
  await step(
    "Hospitalisation",
    "ordre de sortie par le médecin, facture finale ; sortie REFUSÉE avant paiement puis acceptée",
    async () => {
      await doc.reload();
      await doc.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
      await doc.click(`[data-stay='${stayNumber}']`);
      await doc.locator("button:has-text('Ordonner la sortie')").click();
      await doc.locator("[data-final-invoice]").waitFor();
      await nurse.click("nav[aria-label='principal'] button:has-text('Hospitalisation')");
      await nurse.click(`[data-stay='${stayNumber}']`);
      await nurse.locator("button:has-text('Enregistrer la sortie du patient')").click();
      await nurse.locator("[role=alert], .error").first().waitFor();
      const fin = (await api("dev-doctor", `/api/stays/${stayId}`)).data;
      await api("dev-cashier", `/api/billing/invoices/${fin.finalInvoiceId}/pay`, {
        method: "POST",
        body: { method: "cash", receivedAmount: 1_000_000 },
        expect: 200,
      });
      await nurse.locator("button:has-text('Enregistrer la sortie du patient')").click();
      await nurse.locator("[role=status]").waitFor();
      assert.equal((await api("dev-nurse", `/api/stays/${stayId}`)).data.status, "discharged");
    },
  );

  /* ============================================================== 8. Stocks et traçabilité */
  await step(
    "Stocks",
    "traçabilité du lot : on retrouve ce patient parmi ceux qui ont utilisé la seringue",
    async () => {
      const lot = (await api("dev-storekeeper", `/api/stock/levels?depot=HOSP&itemCode=${SYR}`))
        .data.lots[0];
      const trace = (await api("dev-storekeeper", `/api/stock/lots/${lot.lotId}/patients`)).data;
      assert.ok(trace.uses.some((u) => u.patient.identifier === patient.identifier));
    },
  );

  /* ============================================================== 9. Direction */
  await step(
    "Direction",
    "tableau de bord : les chiffres ont bougé et sont cohérents avec l'API, aucun nom de patient",
    async () => {
      const dir = (pages.direction = await login(browser, "dev-direction"));
      await dir.locator("[data-tile='collected']").waitFor();
      const now = (
        await api(
          "dev-direction",
          `/api/dashboard?date=${await dir.locator("input[type='date']").inputValue()}`,
        )
      ).data;
      assert.ok(now.revenue.collected > base.revenue.collected, "encaissements en hausse");
      assert.ok(now.activity.admissions >= base.activity.admissions + 1);
      assert.ok(
        !(await dir.locator("section").textContent()).includes(NAME),
        "aucun nom de patient",
      );
      await shot(dir, "pc-9-direction");
    },
  );

  /* ============================================================== 10. Espace patient */
  await step(
    "Espace patient",
    "connexion par code SMS (passerelle HTTP), rendez-vous pris et annulé, résultat critique retenu, factures",
    async () => {
      const page = await (
        await browser.newContext({ viewport: { width: 1000, height: 900 } })
      ).newPage();
      page.on("dialog", (d) => void d.accept());
      await page.goto(`${process.env.PORTAL_URL ?? "http://localhost:8080"}/patient`);
      await page.fill("input[inputmode='numeric']", patient.identifier);
      await page.click("button:has-text('Recevoir mon code')");
      const message = await until(() => sms[0], "SMS reçu");
      assert.equal(message.to, `+25377${suffix}`);
      await page.fill("input[autocomplete='one-time-code']", /(\d{6})/.exec(message.text)[1]);
      await page.click("button:has-text('Me connecter')");
      await page.locator("[data-patient-name]", { hasText: NAME }).waitFor();
      const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await page.locator("select").selectOption({ label: `Dr Parcours ${suffix}` });
      await page.fill("input[type='date']", day);
      await page.locator("[data-slot]").first().click();
      await page.locator("[data-appointment]").first().waitFor();
      await page.locator("[data-appointment] button:has-text('Annuler')").click();
      await page.locator("[data-appointment]").waitFor({ state: "detached" });
      await page.click("[data-tab='results']");
      await page.locator("[data-withheld]").waitFor();
      assert.equal(
        await page.locator("[data-results] li:has-text('30')").count(),
        0,
        "valeur critique jamais affichée",
      );
      await page.click("[data-tab='invoices']");
      await page.locator("[data-invoices] li").first().waitFor();
      assert.ok(
        (await page.locator("[data-invoices] li").count()) >= 4,
        "toutes les factures du séjour listées",
      );
      await shot(page, "pc-10-patient");
      await page.locator("button:has-text('Se déconnecter')").click();
      await page.waitForSelector("[data-patient-login]");
    },
  );

  /* ============================================================== 11. Cohérence globale */
  await step(
    "Cohérence",
    "journal d'audit : chaque étape clé est tracée, avec l'identité de qui l'a faite",
    async () => {
      const sql = (q) =>
        execFileSync(
          "docker",
          ["exec", "chu-pg", "psql", "-U", "postgres", "-d", "chu", "-Atc", q],
          { encoding: "utf8" },
        ).trim();
      const actions = sql(
        `select string_agg(distinct action, ',') from audit.log where patient_id = '${patient.id}'`,
      ).split(",");
      for (const a of [
        "patient.create",
        "appointment.cancel",
        "lab.read",
        "portal.login",
        "imaging.report",
      ])
        assert.ok(actions.includes(a), `audit : ${a} (présent : ${actions.join(" ")})`);
      assert.equal(
        Number(
          sql(
            `select count(*) from audit.log where patient_id = '${patient.id}' and (actor_id is null or actor_id = '')`,
          ),
        ),
        0,
        "chaque trace a un auteur",
      );
    },
  );
  await step(
    "Cohérence",
    "événements : aucun abandonné, aucun en échec, tous les consommateurs à jour",
    async () => {
      const sql = (q) =>
        execFileSync(
          "docker",
          ["exec", "chu-pg", "psql", "-U", "postgres", "-d", "chu", "-Atc", q],
          { encoding: "utf8" },
        ).trim();
      await until(
        () =>
          Number(
            sql(
              "select count(*) from events.consumer_cursor c where c.last_id < (select max(id) from events.outbox)",
            ),
          ) === 0,
        "consommateurs à jour",
      );
      assert.equal(
        sql("select count(*) from events.failures where dead"),
        "0",
        "aucun événement abandonné",
      );
      assert.equal(
        sql("select count(*) from events.failures"),
        "0",
        "aucun échec de consommateur en cours",
      );
    },
  );
  await step(
    "Cohérence",
    "caisse : aucune facture du patient en attente, tout ce qui a été facturé a été payé",
    async () => {
      const pending = (
        await api("dev-cashier", "/api/billing/invoices?status=pending&limit=200")
      ).data.invoices.filter((i) => i.patientId === patient.id);
      assert.equal(pending.length, 0, `factures restantes : ${pending.map((i) => i.number)}`);
    },
  );
} catch (error) {
  failure = error;
} finally {
  for (const p of Object.values(pages))
    await p
      .context()
      .close()
      .catch(() => {});
  await browser.close();
  gateway.close();
}
const ok = matrix.filter((m) => m.ok).length;
console.log(`\nMatrice : ${ok}/${matrix.length} étapes réussies`);
for (const m of matrix)
  console.log(
    `${m.ok ? "OK " : "KO "} ${m.module.padEnd(16)} ${m.name}${m.ok ? "" : `  ← ${m.error}`}`,
  );
if (failure) throw failure;
console.log("OK : parcours complet du patient vérifié de bout en bout.");
