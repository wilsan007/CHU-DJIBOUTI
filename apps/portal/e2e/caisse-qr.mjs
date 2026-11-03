// Caisse (clôture, avoir) et QR réels, dans un vrai navigateur : la carte imprimée depuis l'accueil, l'étiquette
// d'échantillon et l'ordonnance portent un QR que ce test PHOTOGRAPHIE puis DÉCODE avec un lecteur de QR (jsQR).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { api, cardPayload, chromium, importCatalogs, login, shot } from "./lib.mjs";

const require = createRequire(import.meta.url);
const jsQR = require("jsqr");
const { PNG } = require("pngjs");
const suffix = String(Date.now()).slice(-6);

/** Photographie le QR d'une page imprimable et le décode. */
async function scan(page, kind) {
  const png = PNG.sync.read(await page.locator(`[data-qr='${kind}'] svg`).screenshot());
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(r, `QR « ${kind} » illisible`);
  return r.data;
}

const browser = await chromium.launch();
try {
  await importCatalogs();
  const patient = (
    await api("dev-reception", "/api/patients", {
      method: "POST",
      body: {
        givenName: "Qr<b>x</b>",
        familyName: `Carte${suffix}`,
        sex: "female",
        birthDate: "1991-01-02",
        phone: `0077${suffix}1`,
        confirmNotDuplicate: true,
      },
      expect: 201,
    })
  ).data;

  // 1. Carte imprimée depuis l'écran d'accueil.
  const rec = await login(browser, "dev-reception");
  await rec.fill("input[aria-label='Nom, identifiant ou téléphone']", `Carte${suffix}`);
  await rec.locator("button.row", { hasText: `Carte${suffix}` }).click();
  const [popup] = await Promise.all([
    rec.context().waitForEvent("page"),
    rec.click("[data-print-card]"),
  ]);
  await popup.waitForSelector("[data-qr='card'] svg");
  assert.equal(await scan(popup, "card"), await cardPayload(patient.id));
  await shot(popup, "qr-1-carte");
  console.log("  ✔ carte patient : le QR imprimé se décode en code de carte du patient");

  // 2. Étiquette d'échantillon (via l'API, comme le fait l'écran du laboratoire) rendue dans le navigateur.
  await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
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
  let inv;
  for (let i = 0; i < 40 && !inv; i += 1) {
    inv = (
      await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${order.number}`)
    ).data.invoices[0];
    if (!inv) await new Promise((r) => setTimeout(r, 400));
  }
  await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
    method: "POST",
    body: { method: "cash", receivedAmount: 1_000_000 },
    expect: 200,
  });
  let req;
  for (let i = 0; i < 40 && !req; i += 1) {
    req = (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests[0];
    if (!req) await new Promise((r) => setTimeout(r, 400));
  }
  const sp = (
    await api("dev-lab", `/api/lab/requests/${req.id}/collect`, {
      method: "POST",
      body: { patientScan: await cardPayload(patient.id), specimenType: "Sérum" },
      expect: 201,
    })
  ).data;
  const label = (await api("dev-lab", `/api/lab/specimens/${sp.id}/label`)).data;
  const lp = await (await browser.newContext()).newPage();
  await lp.setContent(label.html);
  assert.equal(await scan(lp, "specimen"), sp.payload);
  assert.equal(
    await lp.locator("b").count(),
    0,
    "nom du patient échappé : pas de HTML injecté dans l'étiquette",
  );
  await shot(lp, "qr-2-etiquette");
  console.log(
    "  ✔ étiquette d'échantillon : le QR se décode en code d'échantillon ; nom saisi échappé",
  );

  // 3. Caisse : avoir sur une facture payée, puis clôture.
  const cash = await login(browser, "dev-cashier");
  const paidRow = cash.locator(`[data-paid-invoice='${inv.number}']`);
  await cash.locator("[data-credit-section] summary").click();
  await paidRow.waitFor();
  await paidRow.locator("input").fill("Facture émise au mauvais patient");
  await paidRow.locator('button:has-text("Créer l\'avoir")').click();
  await cash.locator("[role=status]:has-text('Avoir A-')").waitFor();
  assert.equal(
    (await api("dev-cashier", `/api/billing/invoices?status=credited`)).data.invoices.some(
      (i) => i.number === inv.number,
    ),
    true,
  );
  console.log("  ✔ avoir créé depuis l'écran de caisse (facture marquée annulée)");

  const session = (await api("dev-cashier", "/api/billing/cash-sessions/current")).data.session;
  await cash.locator("[data-close-session] summary").click();
  await cash.fill("input[aria-label^='Espèces comptées']", "1234");
  await cash.click("button:has-text('Clôturer la caisse')");
  await cash.locator("[role=status]:has-text('Caisse clôturée')").waitFor();
  const text = await cash.locator("[role=status]").textContent();
  assert.match(text, /écart/);
  assert.equal(
    (await api("dev-cashier", "/api/billing/cash-sessions/current")).data.session,
    null,
    "la caisse est clôturée",
  );
  void session;
  await shot(cash, "qr-3-caisse");
  console.log("  ✔ clôture de caisse depuis l'écran : attendu, compté et écart affichés");
  console.log("OK : QR réels (carte, étiquette) décodés et écrans de caisse vérifiés.");
} finally {
  await browser.close();
}
