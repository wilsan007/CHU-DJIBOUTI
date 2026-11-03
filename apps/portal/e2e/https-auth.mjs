// Parcours complet derrière le point d'entrée HTTPS, Keycloak servi sous /auth du même nom (aucun autre domaine) :
// connexion, tous les écrans du médecin, aucune violation de la politique de sécurité (CSP), déconnexion.
// Prérequis : voir infra/nginx/README.md (« Essai complet »).
import assert from "node:assert/strict";
import { chromium, PASSWORD } from "./lib.mjs";

const BASE = process.env.HTTPS_URL ?? "https://localhost:8443";
const browser = await chromium.launch();
const msgs = [];
try {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  page.on("console", (m) => msgs.push(`${m.type()}: ${m.text()}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/api/staff/me"))
      msgs.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(BASE);
  await page.waitForSelector("#username");
  assert.ok(
    page.url().startsWith(`${BASE}/auth/realms/chu/`),
    `connexion sous /auth : ${page.url()}`,
  );
  await page.fill("#username", "dev-doctor");
  await page.fill("#password", PASSWORD);
  await page.click("#kc-login");
  await page.waitForSelector(".shell");
  const nav = page.locator("nav[aria-label='principal'] button");
  for (let i = 0; i < (await nav.count()); i += 1) {
    await nav.nth(i).click();
    await page.waitForTimeout(500);
  }
  await page.click("button:has-text('Se déconnecter')");
  await page.waitForSelector("#username");
  assert.ok(page.url().startsWith(`${BASE}/auth/`), "déconnexion : retour à la page de connexion");
  const bad = msgs.filter((m) => /content security policy|refused to|^HTTP/i.test(m));
  assert.deepEqual(bad, [], `Problèmes :\n${bad.join("\n")}`);
  console.log(
    "OK : HTTPS + Keycloak sous /auth : connexion, écrans, déconnexion, aucune violation CSP.",
  );
} finally {
  await browser.close();
}
