// Test de bout en bout dans un vrai navigateur : Keycloak, portail, API et PostgreSQL réels.
// Prérequis et lancement : voir apps/portal/README.md. Les mots de passe viennent de l'environnement.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORTAL = process.env.PORTAL_URL ?? "http://localhost:8080";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8081";
const PASSWORD = process.env.CHU_DEV_USER_PASSWORD;
const SHOTS = process.env.SHOTS_DIR;
if (!PASSWORD) throw new Error("CHU_DEV_USER_PASSWORD est obligatoire");

const ACTS = `code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj
CONS-GEN,Consultation générale,استشارة عامة,2000,CONS,consultation,Responsable test,2026-11-01
LAB-GLY,Glycémie,سكر الدم,1500,LAB,laboratoire,Responsable test,2026-11-01
IMG-RX,Radiographie,تصوير بالأشعة,6000,IMG,imagerie,Responsable test,2026-11-01
`;
const PAYERS = `code,libelle_fr,libelle_ar,part_patient,responsable,date_maj
DIRECT,Paiement direct,دفع مباشر,1,Responsable test,2026-11-01
`;

async function token(user) {
  const res = await fetch(`${KEYCLOAK}/realms/chu/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "chu-dev-cli",
      username: user,
      password: PASSWORD,
    }),
  });
  return (await res.json()).access_token;
}

async function importCatalogs() {
  const t = await token("dev-admin");
  for (const [path, body] of [
    ["payers", PAYERS],
    ["acts", ACTS],
  ]) {
    const res = await fetch(`${PORTAL}/api/catalog/${path}/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "text/csv" },
      body,
    });
    assert.equal(res.status, 200, `import ${path}`);
  }
}

async function login(browser, user, lang = "fr") {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript((l) => {
    try {
      localStorage.setItem("lang", l);
    } catch {
      /* sans importance */
    }
  }, lang);
  const page = await context.newPage();
  await page.goto(PORTAL);
  await page.waitForSelector("#username");
  await page.fill("#username", user);
  await page.fill("#password", PASSWORD);
  await page.click("#kc-login");
  await page.waitForSelector(".shell");
  return page;
}

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

const browser = await chromium.launch();
try {
  await importCatalogs();
  const suffix = String(Date.now()).slice(-6);

  // 1. Réception : création du patient SANS téléphone (facultatif) (avec détection de doublon) et admission.
  const reception = await login(browser, "dev-reception");
  await reception.locator("nav button:has-text('Réception')").waitFor();
  assert.equal(
    await reception.locator("nav button").count(),
    2,
    "la réception voit son écran et « Mon espace », rien d'autre",
  );
  await reception.click("text=Nouveau patient");
  await reception.fill("label:text-is('Prénom') input", "Amina");
  await reception.fill("label:text-is('Nom') input", `Essai${suffix}`);
  await reception.fill("label:text-is('Date de naissance') input", "1990-05-12");
  await reception.click("button:has-text('Enregistrer')");
  await reception.waitForSelector("h2:has-text('Amina')");
  await shot(reception, "1-reception-admission");
  await reception.click("button:has-text('Admettre à la consultation')");
  const notice = await reception.waitForSelector("[role=status]");
  assert.match(await notice.textContent(), /Facture F-\d{6} : 2000 FDJ/);
  const invoiceNumber = (await notice.textContent()).match(/F-\d{6}/)[0];

  // Un deuxième patient presque identique déclenche l'alerte de doublon.
  await reception.click("text=Nouveau patient");
  await reception.fill("label:text-is('Prénom') input", "Amina");
  await reception.fill("label:text-is('Nom') input", `Essai${suffix}`);
  await reception.fill("label:text-is('Date de naissance') input", "1990-05-12");
  await reception.click("button:has-text('Enregistrer')");
  await reception.waitForSelector("[role=alert]:has-text('proches existent')");
  await shot(reception, "2-doublon");

  // 2. Caisse : la facture de consultation, remise, encaissement.
  const cashier = await login(browser, "dev-cashier");
  // La caisse peut déjà être ouverte (relance du test).
  await cashier
    .getByText("Caisse ouverte")
    .or(cashier.getByRole("button", { name: "Ouvrir ma caisse" }))
    .first()
    .waitFor();
  if (await cashier.locator("button:has-text('Ouvrir ma caisse')").count()) {
    await cashier.click("button:has-text('Ouvrir ma caisse')");
  }
  await cashier.waitForSelector("text=Caisse ouverte");
  const card = cashier.locator(`[data-invoice='${invoiceNumber}']`);
  await card.waitFor();
  // Au-delà du plafond de la caisse, la remise est refusée avec un message clair.
  await card.locator("input[placeholder='Remise en %']").fill("50");
  await card.locator("input[placeholder='Motif']").fill("Personnel du CHU");
  await card.locator("button:has-text('Appliquer')").click();
  await card.locator("[role=alert]:has-text('direction')").waitFor();
  await card.locator("input[placeholder='Remise en %']").fill("10");
  await card.locator("input[placeholder='Motif']").fill("Personnel du CHU");
  await card.locator("button:has-text('Appliquer')").click();
  await card.locator("text=/1\\s800 FDJ/").first().waitFor();
  await shot(cashier, "3-caisse-remise");
  await card.locator("button:has-text('Encaisser')").click();
  await cashier.waitForSelector("[role=status]:has-text('Payé. Reçu')");

  // 3. Médecin : le patient est dans la file, demande d'une analyse (payée à la caisse avant exécution).
  const doctor = await login(browser, "dev-doctor");
  const row = doctor.locator("button.row", { hasText: `Essai${suffix}` });
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await doctor.waitForSelector("h3:has-text('Demander des prestations')");
  await doctor.click("label:has-text('Glycémie') input");
  await shot(doctor, "4-medecin-demande");
  await doctor.click("button:has-text('Envoyer à la caisse')");
  const sent = await doctor.waitForSelector("[role=status]:has-text('envoyée à la caisse')");
  const orderNumber = (await sent.textContent()).match(/O-\d{6}/)[0];

  // La demande n'a pas de ticket tant que la caisse n'a pas encaissé.
  const adminToken = await token("dev-admin");
  const ordersRes = await (
    await fetch(`${PORTAL}/api/service-orders?status=awaiting_payment`, {
      headers: { authorization: `Bearer ${await token("dev-doctor")}` },
    })
  ).json();
  assert.ok(
    ordersRes.orders.some((o) => o.number === orderNumber),
    "demande en attente de paiement",
  );
  void adminToken;

  // 4. La caisse voit la facture de la demande et l'encaisse ; seulement alors le laboratoire reçoit son ticket.
  const orderCard = cashier.locator(`[data-invoice]`, { hasText: orderNumber });
  await orderCard.waitFor({ timeout: 15000 });
  await orderCard.locator("button:has-text('Encaisser')").click();
  await cashier.waitForSelector("[role=status]:has-text('Payé. Reçu')");
  const labToken = await token("dev-lab");
  let tickets = [];
  for (let i = 0; i < 20 && tickets.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    tickets = (
      await (
        await fetch(`${PORTAL}/api/department-tickets?department=LAB`, {
          headers: { authorization: `Bearer ${labToken}` },
        })
      ).json()
    ).tickets;
  }
  assert.ok(
    tickets.some((x) => x.orderNumber === orderNumber),
    "ticket du laboratoire libéré après paiement",
  );

  // 5. Arabe : le même écran en arabe, de droite à gauche.
  const ar = await login(browser, "dev-reception", "ar");
  assert.equal(await ar.evaluate(() => document.documentElement.dir), "rtl");
  assert.ok((await ar.textContent("h1")).includes("استقبال"));
  await shot(ar, "5-arabe");

  console.log(
    "OK : parcours réception, caisse, médecin et laboratoire vérifié dans le navigateur.",
  );
} finally {
  await browser.close();
}
