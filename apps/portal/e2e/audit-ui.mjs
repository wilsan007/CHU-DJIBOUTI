/* global window, axe */
// Audit automatique de TOUS les écrans pour TOUS les rôles (français et arabe, ordinateur et téléphone) :
// - accessibilité (axe-core : noms des boutons, étiquettes des champs, contrastes, structure) ;
// - erreurs de console, erreurs de page, appels réseau en échec (4xx/5xx inattendus) ;
// - textes non traduits (clés brutes, « undefined », « NaN », « [object Object] ») ;
// - boutons et champs trop petits pour le doigt (téléphone) ou sans nom ;
// - chaque bouton visible : activé ou désactivé (liste pour revue), débordement horizontal.
// Écrit un rapport JSON (AUDIT_OUT) et échoue s'il reste des problèmes « bloquants ».
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium, login, PORTAL } from "./lib.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const OUT = process.env.AUDIT_OUT ?? "/tmp/audit-ui.json";
const USERS = [
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
const MODES = [
  { name: "bureau-fr", lang: "fr", viewport: { width: 1280, height: 900 } },
  { name: "bureau-ar", lang: "ar", viewport: { width: 1280, height: 900 } },
  { name: "mobile-fr", lang: "fr", viewport: { width: 360, height: 740 } },
  { name: "sombre-fr", lang: "fr", viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
];
// Aucune réponse 4xx/5xx n'est tolérée : les états normaux (sans fiche, sans consultation) répondent 204.
const ALLOWED_HTTP = [];

const findings = [];
const buttonsSeen = {};
const add = (f) => findings.push(f);

async function auditPage(page, ctx, collected) {
  await page.addScriptTag({ content: AXE }).catch(() => {});
  const violations = await page
    .evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 4).map((n) => ({
          target: n.target.join(" "),
          html: n.html.slice(0, 140),
          summary: (n.failureSummary || "").slice(0, 160),
        })),
      }));
    })
    .catch(() => []);
  for (const v of violations)
    add({ ...ctx, kind: "axe", rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes });

  const dom = await page.evaluate(() => {
    const out = {
      mute: [],
      badText: [],
      small: [],
      noName: [],
      buttons: [],
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
    const text = document.body.innerText;
    for (const m of text.matchAll(
      /\b(undefined|NaN|\[object Object\]|(?:nav|common|error|cashier|reception|doctor|lab|pharmacy|stock|staff|hosp|imaging|direction|admin|patient)\.[a-zA-Z.]+)\b/g,
    ))
      out.badText.push(m[0]);
    for (const el of document.querySelectorAll(
      "button, a[href], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, summary",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const name = (
        el.getAttribute("aria-label") ||
        el.textContent ||
        el.getAttribute("placeholder") ||
        el.labels?.[0]?.textContent ||
        el.getAttribute("title") ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ");
      if (!name && el.tagName !== "SELECT") out.noName.push(el.outerHTML.slice(0, 120));
      if (r.height < 36 || (el.tagName === "BUTTON" && r.width < 36))
        out.small.push({
          tag: el.tagName.toLowerCase(),
          name: name.slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      if (el.tagName === "BUTTON") {
        // Un bouton inactif doit dire pourquoi : raison reliée (aria-describedby) ou info-bulle.
        if (el.disabled && el.closest("main") && !el.getAttribute("aria-describedby") && !el.title)
          out.mute.push(name.slice(0, 50));
        out.buttons.push({ name: name.slice(0, 60), disabled: el.disabled });
      }
    }
    return out;
  });
  for (const m of dom.mute)
    add({ ...ctx, kind: "texte-brut", text: `bouton inactif sans explication : ${m}` });
  for (const t of dom.badText) add({ ...ctx, kind: "texte-brut", text: t });
  for (const n of dom.noName) add({ ...ctx, kind: "sans-nom", html: n });
  if (ctx.mode.startsWith("mobile"))
    for (const s of dom.small) add({ ...ctx, kind: "cible-petite", ...s });
  if (dom.overflow > 1) add({ ...ctx, kind: "debordement", px: dom.overflow });
  for (const e of collected.splice(0)) add({ ...ctx, kind: "reseau-console", detail: e });
  buttonsSeen[`${ctx.role}|${ctx.screen}`] = [
    ...new Set(dom.buttons.map((b) => b.name + (b.disabled ? " (inactif)" : ""))),
  ];
}

/** Audite la vue, puis ouvre les volets repliables et les deux premiers éléments cliquables des listes (panneaux de détail). */
async function auditView(page, ctx, collected) {
  await auditPage(page, ctx, collected);
  const summaries = page.locator("main details > summary");
  for (let k = 0; k < Math.min(await summaries.count(), 4); k += 1)
    await summaries
      .nth(k)
      .click()
      .catch(() => {});
  if (await summaries.count())
    await auditPage(page, { ...ctx, screen: `${ctx.screen} › volets ouverts` }, collected);
  const rows = page.locator("main button.row, main [data-stay], main [data-user] summary");
  for (let k = 0; k < Math.min(await rows.count(), 2); k += 1) {
    await rows
      .nth(k)
      .click()
      .catch(() => {});
    await page.waitForTimeout(900);
    await auditPage(page, { ...ctx, screen: `${ctx.screen} › élément ${k + 1}` }, collected);
  }
}

const browser = await chromium.launch();
try {
  for (const mode of MODES) {
    for (const user of USERS) {
      const page = await login(
        browser,
        user,
        mode.lang,
        mode.viewport,
        mode.colorScheme ?? "light",
      );
      const collected = [];
      page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
          collected.push(`console: ${m.text().slice(0, 160)}`);
      });
      page.on("pageerror", (e) => collected.push(`pageerror: ${e.message.slice(0, 160)}`));
      page.on("response", (r) => {
        if (r.status() >= 400 && !ALLOWED_HTTP.some((re) => re.test(r.url())))
          collected.push(`HTTP ${r.status()} ${r.url().replace(PORTAL, "")}`);
      });
      const nav = page.locator("nav[aria-label='principal'] button");
      const count = await nav.count();
      for (let i = 0; i < count; i += 1) {
        await nav.nth(i).click();
        await page.waitForTimeout(900);
        const screen = (await nav.nth(i).textContent())?.trim();
        await auditView(page, { mode: mode.name, role: user, screen }, collected);
        const tabs = page.locator(".subtabs button");
        const tc = await tabs.count();
        for (let j = 0; j < tc; j += 1) {
          await tabs.nth(j).click();
          await page.waitForTimeout(700);
          await auditView(
            page,
            {
              mode: mode.name,
              role: user,
              screen: `${screen} › ${(await tabs.nth(j).textContent())?.trim()}`,
            },
            collected,
          );
        }
      }
      await page.context().close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(OUT, JSON.stringify({ findings, buttonsSeen }, null, 1));
const by = {};
for (const f of findings) {
  const k = `${f.kind}${f.rule ? `:${f.rule}` : ""}${f.impact ? `(${f.impact})` : ""}`;
  (by[k] ??= new Set()).add(`${f.screen}`);
}
for (const [k, v] of Object.entries(by).sort())
  console.log(
    `${String(findings.filter((f) => `${f.kind}${f.rule ? `:${f.rule}` : ""}${f.impact ? `(${f.impact})` : ""}` === k).length).padStart(4)}  ${k}  [${[...v].slice(0, 6).join(" | ")}${v.size > 6 ? " …" : ""}]`,
  );
const blocking = findings.filter(
  (f) =>
    ["texte-brut", "sans-nom", "debordement"].includes(f.kind) ||
    (f.kind === "axe" && ["critical", "serious"].includes(f.impact)) ||
    f.kind === "reseau-console",
);
console.log(`\n${findings.length} constats, dont ${blocking.length} bloquants. Rapport : ${OUT}`);
assert.equal(blocking.length, 0, `${blocking.length} problèmes bloquants`);
