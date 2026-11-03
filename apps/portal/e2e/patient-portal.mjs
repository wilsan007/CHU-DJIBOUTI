/* global axe */
// Espace patient dans un vrai navigateur : le code arrive par la VRAIE passerelle SMS HTTP du noyau (ici un serveur de
// test), connexion, prise et annulation de rendez-vous, résultats (valeur critique retenue), factures, arabe, mobile.
// Prérequis : l'API démarrée avec PORTAL_JWT_SECRET, SMS_GATEWAY_URL=http://127.0.0.1:4599/sms,
// SMS_GATEWAY_AUTHORIZATION="Bearer passerelle-essai" et PORTAL_RESULT_DELAY_HOURS=0.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { api, cardPayload, chromium, importCatalogs, PORTAL, shot, sleep } from "./lib.mjs";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
/** Accessibilité (axe-core) de la vue courante : aucune violation sérieuse ou critique. */
async function axeCheck(page, where) {
  await page.addScriptTag({ content: AXE });
  const v = await page.evaluate(async () => {
    const r = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
    });
    return r.violations
      .filter((x) => ["serious", "critical", "moderate"].includes(x.impact))
      .map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 80)}`);
  });
  assert.deepEqual(v, [], `accessibilité (${where})`);
}
const suffix = String(Date.now()).slice(-6);
const messages = [];
const gateway = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    messages.push({ auth: req.headers.authorization, ...JSON.parse(raw) });
    res.end("{}");
  });
});
await new Promise((r) => gateway.listen(4599, "127.0.0.1", r));
const until = async (fn, what, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`Délai dépassé : ${what}`);
};
const newPatient = async (name) =>
  (
    await api("dev-reception", "/api/patients", {
      method: "POST",
      body: {
        givenName: name,
        familyName: `Patient${suffix}`,
        sex: "female",
        birthDate: "1982-03-04",
        phone: `0025377${suffix}`,
        confirmNotDuplicate: true,
      },
      expect: 201,
    })
  ).data;

const browser = await chromium.launch();
try {
  await importCatalogs();
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
  const PRACT = `dr-portail-${suffix}`;
  await api("dev-admin", `/api/schedule/practitioners/${PRACT}`, {
    method: "PUT",
    body: { displayName: `Dr Portail ${suffix}`, departmentCode: "CONS" },
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

  const patient = await newPatient("Aïcha");
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

  // Deux analyses validées : une normale, une critique.
  for (let n = 0; n < 2; n += 1) {
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
      body: { method: "cash", receivedAmount: 1_000_000 },
      expect: 200,
    });
  }
  const reqs = await until(async () => {
    const r = (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests;
    return r.length === 2 ? r : null;
  }, "deux demandes du laboratoire");
  for (const [i, value] of [5.2, 30].entries()) {
    const sp = (
      await api("dev-lab", `/api/lab/requests/${reqs[i].id}/collect`, {
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
      body: { testCode: "GLY", value },
      expect: 201,
    });
    await api("dev-lab", `/api/lab/specimens/${sp.id}/validate-technical`, {
      method: "POST",
      body: {},
      expect: 200,
    });
    await api("dev-biologist", `/api/lab/specimens/${sp.id}/validate-biological`, {
      method: "POST",
      body: {},
      expect: 200,
    });
  }

  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${PORTAL}/patient`);
  await page.waitForSelector("[data-patient-login]");
  await axeCheck(page, "connexion");
  await shot(page, "patient-1-login");

  // Dossier inconnu : même écran, aucun SMS.
  await page.fill("input[inputmode='numeric']", "999999");
  await page.click("button:has-text('Recevoir mon code')");
  await page.locator("[role=status]").waitFor();
  await sleep(1500);
  assert.equal(messages.length, 0, "aucun SMS pour un dossier inconnu");
  await page.click("button:has-text('Retour')");

  // Dossier connu : le SMS passe par la passerelle HTTP du noyau.
  await page.fill("input[inputmode='numeric']", patient.identifier);
  await page.click("button:has-text('Recevoir mon code')");
  const sms = await until(() => messages[0], "SMS reçu par la passerelle");
  assert.equal(sms.auth, "Bearer passerelle-essai", "jeton de la passerelle transmis");
  assert.equal(sms.to, `+25377${suffix}`, "numéro normalisé au format international");
  const code = /(\d{6})/.exec(sms.text)[1];
  console.log(
    "  ✔ SMS reçu par la passerelle, numéro +253…, code à 6 chiffres, aucun SMS pour un dossier inconnu",
  );

  // Mauvais code puis bon code.
  const wrong = code === "000000" ? "111111" : "000000";
  await page.fill("input[autocomplete='one-time-code']", wrong);
  await page.click("button:has-text('Me connecter')");
  await page.locator("[role=alert]").waitFor();
  await page.fill("input[autocomplete='one-time-code']", code);
  await page.click("button:has-text('Me connecter')");
  await page.locator("[data-patient-name]:has-text('Aïcha')").waitFor();
  console.log("  ✔ mauvais code refusé, bon code accepté");

  // Rendez-vous : prise puis annulation.
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await page.locator("select").selectOption({ label: `Dr Portail ${suffix}` });
  await page.fill("input[type='date']", day);
  const slot = page.locator("[data-slot]").first();
  await slot.waitFor();
  await slot.click();
  await page.locator("[data-appointment]").first().waitFor();
  await axeCheck(page, "rendez-vous");
  await shot(page, "patient-2-appointments");
  const mine = await page.locator("[data-appointment]").count();
  assert.equal(mine, 1);
  await page.locator("[data-appointment] button:has-text('Annuler')").click();
  await page.locator("[data-appointment]").waitFor({ state: "detached" });
  console.log("  ✔ créneau pris puis annulé depuis l'espace patient");

  // Résultats : le normal est montré, le critique est retenu avec un message.
  await page.click("[data-tab='results']");
  await page.locator("[data-results] li:has-text('5.2')").waitFor();
  assert.equal(
    await page.locator("[data-results] li:has-text('30')").count(),
    0,
    "valeur critique jamais affichée",
  );
  await page.locator("[data-withheld]").waitFor();
  await axeCheck(page, "résultats");
  await shot(page, "patient-3-results");
  console.log(
    "  ✔ résultat normal affiché, valeur critique retenue avec invitation à contacter le médecin",
  );

  // Factures.
  await page.click("[data-tab='invoices']");
  await page.locator("[data-invoices] li").first().waitFor();

  // Arabe : sens de lecture inversé et textes arabes.
  await page.click("button:has-text('العربية')");
  await page.locator("html[dir='rtl']").waitFor();
  assert.ok((await page.locator("[data-tab='results']").textContent()).includes("النتائج"));
  await shot(page, "patient-4-ar");
  await page.click("button:has-text('Français'), button:has-text('Fran')").catch(() => {});

  // Téléphone : rien ne déborde.
  await page.setViewportSize({ width: 360, height: 740 });
  const m = await page.evaluate(
    "({ doc: document.documentElement.scrollWidth, win: window.innerWidth })",
  );
  assert.ok(m.doc <= m.win + 1, `débordement sur téléphone : ${m.doc} > ${m.win}`);
  await shot(page, "patient-5-mobile");

  // Déconnexion : le jeton n'ouvre plus rien.
  const token = await page.evaluate("sessionStorage.getItem('patient-token')");
  assert.ok(token);
  await page.locator("button:has-text('Se déconnecter'), button:has-text('تسجيل الخروج')").click();
  await page.waitForSelector("[data-patient-login]");
  assert.equal(
    (await fetch(`${PORTAL}/api/portal/me`, { headers: { authorization: `Bearer ${token}` } }))
      .status,
    401,
  );
  assert.equal(await page.evaluate("sessionStorage.getItem('patient-token')"), null);
  console.log("  ✔ arabe (RTL), téléphone sans débordement, déconnexion qui révoque la session");
  console.log("OK : espace patient vérifié dans le navigateur.");
} finally {
  await browser.close();
  gateway.close();
}
