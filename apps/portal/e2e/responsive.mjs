// Téléphone et tablette : chaque écran de chaque rôle doit tenir dans la largeur (pas de défilement horizontal de
// la page), en français comme en arabe, et rester utilisable (menu visible, texte non coupé hors écran).
import assert from "node:assert/strict";
import { chromium, login, shot } from "./lib.mjs";

const SIZES = [
  { name: "telephone", width: 360, height: 740 },
  { name: "tablette", width: 768, height: 1024 },
];
const USERS = [
  "dev-reception",
  "dev-cashier",
  "dev-doctor",
  "dev-nurse",
  "dev-biologist",
  "dev-pharmacy",
  "dev-storekeeper",
  "dev-hr",
  "dev-imaging",
  "dev-direction",
  "dev-admin",
];

const browser = await chromium.launch();
const problems = [];
try {
  for (const size of SIZES) {
    for (const lang of ["fr", "ar"]) {
      for (const user of USERS) {
        const page = await login(browser, user, lang, size);
        const buttons = page.locator("nav[aria-label='principal'] button");
        const count = await buttons.count();
        for (let i = 0; i < count; i += 1) {
          await buttons.nth(i).click();
          await page.waitForTimeout(700);
          const name = (await buttons.nth(i).textContent())?.trim();
          const m = await page.evaluate(
            "({ doc: document.documentElement.scrollWidth, win: window.innerWidth })",
          );
          if (m.doc > m.win + 1)
            problems.push(`${size.name}/${lang}/${user}/${name} : largeur ${m.doc} > ${m.win}`);
          if (i === 0 && lang === "fr") await shot(page, `resp-${size.name}-${user}`);
        }
        await page.context().close();
      }
    }
  }
} finally {
  await browser.close();
}
assert.deepEqual(problems, [], `Débordements :\n${problems.join("\n")}`);
console.log("OK : tous les écrans tiennent sur téléphone et tablette, en français et en arabe.");
