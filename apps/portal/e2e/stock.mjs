// Écrans des stocks et du matériel utilisé, dans un vrai navigateur : réception, transferts, recettes d'actes,
// consommation automatique à la fin d'une analyse, manque à régulariser, matériel utilisé par une infirmière.
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
const SYR = `SY${suffix}`;
const REA = `RE${suffix}`;
const IMPORTED = `IM${suffix}`;
const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

const browser = await chromium.launch();
try {
  await importCatalogs();
  await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
  const items = `code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj\n${SYR},Seringue 5 ml ${suffix},محقنة,consommable,seringue,Magasinier test,2026-11-01\n${REA},Réactif glycémie ${suffix},كاشف,reactif,test,Biologiste test,2026-11-01\n`;
  await api("dev-storekeeper", "/api/stock/items/import", {
    method: "POST",
    csv: items,
    expect: 200,
  });

  const keeper = await login(browser, "dev-storekeeper");
  await keeper.locator("nav button:has-text('Stocks')").waitFor();
  assert.equal(
    await keeper.locator("nav[aria-label='principal'] button").count(),
    2,
    "le magasinier ne voit que le stock et « Mon espace » (pas de dossiers de patients)",
  );

  /* ------------------------------------------------ réception */
  await keeper.click("[data-tab='receive']");
  const receive = async (code, lot, qty) => {
    await keeper.locator("select[aria-label='Dépôt']").selectOption({ label: "Magasin central" });
    await keeper.fill("input[aria-label='Chercher un article (code ou nom)']", code);
    await keeper.click(`button[data-item='${code}']`);
    await keeper.fill("label:text-is('Numéro de lot') input", lot);
    await keeper.fill("label:text-is('Péremption') input", expires);
    await keeper.fill("label:text-is('Quantité') input", String(qty));
    await keeper.click("button:has-text('Enregistrer la réception')");
  };
  // Un médicament relève de la pharmacie : refusé au magasinier.
  await receive("PAR-500", `X${suffix}`, 5);
  await keeper.locator("[role=alert]:has-text('gérés par la pharmacie')").waitFor();
  await keeper.click("button:has-text('×')");
  await receive(SYR, `LS${suffix}`, 100);
  await keeper.locator("[role=status]:has-text('Réception enregistrée')").waitFor();
  await receive(REA, `LR${suffix}`, 3);
  await keeper.locator(`[role=status]:has-text('${REA}')`).waitFor();

  /* ------------------------------------------------ transferts */
  await keeper.click("[data-tab='transfer']");
  await keeper
    .locator("select[aria-label='Dépôt d\\'origine']")
    .selectOption({ label: "Magasin central" });
  await keeper
    .locator("select[aria-label='Dépôt de destination']")
    .selectOption({ label: "Réserve du laboratoire" });
  const transfer = async (code, qty) => {
    await keeper
      .locator("select[aria-label='Lot']")
      .selectOption({ index: 0 })
      .catch(() => null);
    const option = keeper.locator("select[aria-label='Lot'] option", { hasText: code });
    await option.first().waitFor({ state: "attached" });
    await keeper
      .locator("select[aria-label='Lot']")
      .selectOption({ value: await option.first().getAttribute("value") });
    await keeper.fill("label:text-is('Quantité') input", String(qty));
    await keeper.click("button:has-text('Transférer')");
  };
  await transfer(SYR, 99999);
  await keeper.locator("[role=alert]:has-text('Stock insuffisant')").waitFor();
  await transfer(SYR, 20);
  await keeper.locator("[role=status]:has-text('Transfert T-')").waitFor();
  await transfer(REA, 3);
  await keeper.locator("[role=status]:has-text('Transfert T-')").waitFor();

  /* ------------------------------------------------ recettes d'actes */
  await keeper.click("[data-tab='recipes']");
  await keeper.locator("select[aria-label='Acte']").selectOption({ value: "LAB-GLY" });
  await sleep(1000); // chargement de la recette existante
  // La recette existante se charge à l'écran : on la vide pour que le test se rejoue à l'identique.
  while (await keeper.locator("tr[data-line] button:has-text('×')").count()) {
    await keeper.locator("tr[data-line] button:has-text('×')").first().click();
  }
  for (const [code, qty] of [
    [REA, 2],
    [SYR, 1],
  ]) {
    await keeper.fill("input[aria-label='Chercher un article (code ou nom)']", code);
    await keeper.click(`button[data-item='${code}']`);
    await keeper.locator(`tr[data-line='${code}'] input`).fill(String(qty));
  }
  await keeper.fill("label:has-text('Responsable de la recette') input", "Biologiste test");
  await keeper.click("button:has-text('Enregistrer la recette')");
  await keeper.locator("[role=status]:has-text('Recette de LAB-GLY enregistrée')").waitFor();
  const saved = (await api("dev-storekeeper", "/api/stock/recipes?act=LAB-GLY", { expect: 200 }))
    .data.recipes;
  assert.deepEqual(
    saved.map((r) => [r.itemCode, r.quantity]).sort(),
    [
      [REA, 2],
      [SYR, 1],
    ].sort(),
  );
  await shot(keeper, "30-stock-recettes");

  /* ------------------------------------------------ niveaux et alerte de seuil */
  await keeper.click("[data-tab='levels']");
  await keeper
    .locator("select[aria-label='Dépôt']")
    .selectOption({ label: "Réserve du laboratoire" });
  await keeper.locator(`tr[data-lot='LR${suffix}']`).waitFor();
  await keeper.fill("input[aria-label='Chercher un article (code ou nom)']", REA);
  await keeper.click(`button[data-item='${REA}']`);
  await keeper.fill("input[aria-label='Seuil minimal']", "50");
  await keeper.click("button:has-text('Fixer le seuil')");
  await keeper.locator(`[data-below='${REA}']`).waitFor();

  /* ------------------------------------------------ consommation automatique à la fin d'une analyse */
  const lab = async () => {
    const patient = (
      await api("dev-reception", "/api/patients", {
        method: "POST",
        body: {
          givenName: "Reactif",
          familyName: `Essai${suffix}${Math.floor(Math.random() * 90 + 10)}`,
          sex: "male",
          birthDate: "1980-01-01",
          phone: `0077${suffix}${Math.floor(Math.random() * 90 + 10)}`,
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
    const inv = await until(
      async () =>
        (
          await api(
            "dev-cashier",
            `/api/billing/invoices?status=pending&orderNumber=${order.number}`,
          )
        ).data.invoices[0],
      "facture",
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
      body: { testCode: "GLY", value: 5 },
      expect: 201,
    });
    await api("dev-lab", `/api/lab/specimens/${sp.id}/validate-technical`, {
      method: "POST",
      expect: 200,
    });
    await api("dev-biologist", `/api/lab/specimens/${sp.id}/validate-biological`, {
      method: "POST",
      expect: 200,
    });
    return patient;
  };
  const labStock = async (code) => {
    const lots = (
      await api("dev-storekeeper", `/api/stock/levels?depot=LAB&itemCode=${code}`, { expect: 200 })
    ).data.lots;
    return lots.reduce((n, l) => n + l.quantity, 0);
  };
  await lab();
  await until(async () => (await labStock(REA)) === 1, "réactifs prélevés (3 - 2 = 1)");
  assert.equal(await labStock(SYR), 19);

  // Deuxième analyse : un seul réactif en réserve pour deux requis : le manque est signalé, l'acte n'est pas bloqué.
  await lab();
  await until(async () => (await labStock(REA)) === 0, "dernier réactif prélevé");
  await keeper.click("[data-tab='shortfalls']");
  const gap = keeper.locator(`[data-shortfall='${REA}']`);
  await gap.waitFor({ timeout: 20000 });
  assert.ok((await gap.textContent()).includes("Manque : 1"));
  await shot(keeper, "31-stock-manque");
  await gap.locator("input").fill("Régularisé après réception du lot suivant");
  await gap.locator("button:has-text('Régulariser')").click();
  await gap.waitFor({ state: "detached" });

  /* ------------------------------------------------ articles : import CSV */
  await keeper.click("[data-tab='items']");
  await keeper.fill(
    "textarea",
    `code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj\n${IMPORTED},Gants stériles ${suffix},قفازات,consommable,paire,Magasinier test,2026-11-01\n`,
  );
  await keeper.click("button:has-text('Importer')");
  await keeper.locator("[role=status]:has-text('1 article(s) importé(s), 0 rejeté(s)')").waitFor();

  /* ------------------------------------------------ matériel utilisé par une infirmière */
  await api("dev-storekeeper", "/api/stock/transfers", {
    method: "POST",
    body: {
      from: "MG",
      to: "HOSP",
      lines: [
        {
          lotId: (await api("dev-storekeeper", `/api/stock/levels?depot=MG&itemCode=${SYR}`)).data
            .lots[0].lotId,
          quantity: 10,
        },
      ],
    },
    expect: 201,
  });
  const patient = (
    await api("dev-reception", "/api/patients", {
      method: "POST",
      body: {
        givenName: "Pansement",
        familyName: `Soin${suffix}`,
        sex: "female",
        birthDate: "1975-02-02",
        phone: `0077${suffix}9`,
        confirmNotDuplicate: true,
      },
      expect: 201,
    })
  ).data;
  const nurse = await login(browser, "dev-nurse");
  await nurse.locator("nav button:has-text('Matériel utilisé')").click();
  await nurse
    .locator("select[aria-label='Dépôt']")
    .selectOption({ label: "Réserve d'hospitalisation et bloc" });
  await nurse.fill("input[aria-label='Chercher un article (code ou nom)']", "paracetamol");
  await sleep(800);
  assert.equal(
    await nurse.locator("button[data-item]").count(),
    0,
    "les médicaments ne se saisissent pas comme matériel",
  );
  await nurse.fill("input[aria-label='Chercher un article (code ou nom)']", SYR);
  await nurse.click(`button[data-item='${SYR}']`);
  await nurse.fill("label:text-is('Quantité') input", "4");
  await nurse.fill("input[aria-label='Patient concerné (facultatif)']", `Soin${suffix}`);
  await nurse.click(`button.row:has-text('Soin${suffix}')`);
  await nurse.fill("label:has-text('Motif') input", "Pansement et injection");
  await nurse.click("button:has-text('Enregistrer l\\'utilisation')");
  await nurse.locator(`[role=status]:has-text('${SYR}')`).waitFor();
  await shot(nurse, "32-materiel-utilise");
  const trace = (
    await api(
      "dev-storekeeper",
      `/api/stock/lots/${(await api("dev-storekeeper", `/api/stock/levels?depot=HOSP&itemCode=${SYR}`)).data.lots[0].lotId}/patients`,
      { expect: 200 },
    )
  ).data;
  const mine = trace.uses.find((u) => u.patient.identifier === patient.identifier);
  assert.ok(mine, "retrouvé dans la traçabilité du lot");
  assert.equal(mine.quantity, 4);
  assert.equal(mine.kind, "consume");

  console.log(
    "OK : stocks, recettes d'actes, consommation automatique et matériel utilisé vérifiés dans le navigateur.",
  );
} finally {
  await browser.close();
}
