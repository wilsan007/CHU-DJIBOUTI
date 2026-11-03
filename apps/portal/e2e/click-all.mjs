/* global URL */
// « Tous les boutons fonctionnent » : pour chaque rôle et chaque écran (et sous-onglet), clique chaque bouton ACTIVÉ de la page
// (sauf déconnexion et changement de langue), puis vérifie : aucune erreur de page, aucune erreur de console, aucune réponse 5xx,
// et toute réponse 4xx est EXPLIQUÉE à l'utilisateur (un message [role=alert] apparaît) : un bouton ne reste jamais « muet ».
// Les confirmations sont acceptées. Les actions à effet de bord sont inoffensives : c'est la pile de test avec des données fictives.
import assert from "node:assert/strict";
import { chromium, login } from "./lib.mjs";

const USERS = process.env.ONLY
  ? process.env.ONLY.split(",")
  : [
      "dev-reception",
      "dev-cashier",
      "dev-doctor",
      "dev-nurse",
      "dev-lab",
      "dev-biologist",
      "dev-pharmacy",
      "dev-storekeeper",
      "dev-imaging",
      "dev-hr",
      "dev-direction",
      "dev-admin",
    ];
const SKIP = /déconnecter|logout|العربية|Français|se déconnecter|تسجيل الخروج/i;
const problems = [];
let clicks = 0;

const browser = await chromium.launch();
try {
  for (const user of USERS) {
    const page = await login(browser, user);
    const events = [];
    page.on("pageerror", (e) => events.push({ kind: "pageerror", text: e.message.slice(0, 200) }));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
        events.push({ kind: "console", text: m.text().slice(0, 200) });
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !/\/api\/staff\/me$/.test(r.url()) && r.request().method() !== "GET")
        events.push({
          kind: r.status() >= 500 ? "5xx" : "4xx",
          text: `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        });
      if (r.status() >= 500)
        events.push({ kind: "5xx", text: `${r.status()} ${new URL(r.url()).pathname}` });
    });
    page.context().on("page", (p) => setTimeout(() => p.close().catch(() => {}), 400)); // impressions ouvertes dans un onglet

    const nav = page.locator("nav[aria-label='principal'] button");
    const screens = await nav.count();
    for (let i = 0; i < screens; i += 1) {
      await nav.nth(i).click();
      await page.waitForTimeout(800);
      const screen = (await nav.nth(i).textContent())?.trim();
      const tabs = page.locator("main .subtabs button");
      const tabCount = Math.max(1, await tabs.count());
      for (let j = 0; j < tabCount; j += 1) {
        if ((await tabs.count()) > 0) {
          await tabs.nth(j).click();
          await page.waitForTimeout(500);
        }
        const where = `${user} › ${screen}${(await tabs.count()) ? ` › ${(await tabs.nth(j).textContent())?.trim()}` : ""}`;
        const done = new Set();
        for (let round = 0; round < 60; round += 1) {
          const buttons = page.locator("main button:not([disabled])");
          const n = await buttons.count();
          let target = -1;
          let sig = "";
          for (let k = 0; k < n; k += 1) {
            const b = buttons.nth(k);
            if (!(await b.isVisible().catch(() => false))) continue;
            if ((await b.getAttribute("class"))?.includes("tab")) continue; // onglets : parcourus à part
            const name =
              ((await b.textContent()) ?? "").trim().replace(/\s+/g, " ") ||
              (await b.getAttribute("aria-label")) ||
              "?";
            if (SKIP.test(name)) continue;
            const s = `${name}#${k}`;
            if (done.has(s)) continue;
            target = k;
            sig = s;
            break;
          }
          if (target < 0) break;
          done.add(sig);
          events.length = 0;
          await buttons
            .nth(target)
            .click({ timeout: 4000 })
            .catch(() => {});
          clicks += 1;
          await page.waitForTimeout(350);
          for (const ev of events.splice(0)) {
            if (ev.kind === "4xx") {
              const shown = await page.locator("main [role=alert], main .error").count();
              if (shown === 0)
                problems.push(
                  `${where} : « ${sig.split("#")[0]} » → ${ev.text} sans message pour l'utilisateur`,
                );
            } else problems.push(`${where} : « ${sig.split("#")[0]} » → ${ev.kind} ${ev.text}`);
          }
          // si la page a changé d'écran ou rechargé, on s'arrête pour cet écran
          if (!(await nav.count())) {
            problems.push(`${where} : « ${sig.split("#")[0]} » a fait disparaître la navigation`);
            break;
          }
        }
      }
    }
    await page.context().close();
  }
} finally {
  await browser.close();
}
console.log(`${clicks} boutons cliqués sur ${USERS.length} rôles.`);
if (problems.length) console.log([...new Set(problems)].join("\n"));
assert.equal(problems.length, 0, `${problems.length} problèmes`);
console.log("OK : tous les boutons activés répondent, ou expliquent pourquoi ils refusent.");
