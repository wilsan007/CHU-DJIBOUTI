// Captures de tous les écrans de tous les rôles (bureau, téléphone, sombre) pour la revue de design. SHOTS_DIR obligatoire.
import { chromium, login, SHOTS } from "./lib.mjs";

if (!SHOTS) throw new Error("SHOTS_DIR est obligatoire");
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
  { n: "d", viewport: { width: 1280, height: 900 }, scheme: "light" },
  { n: "m", viewport: { width: 390, height: 780 }, scheme: "light" },
  { n: "s", viewport: { width: 1280, height: 900 }, scheme: "dark" },
];
const only = process.env.ONLY?.split(",");
const browser = await chromium.launch();
try {
  for (const mode of MODES) {
    for (const user of only ?? USERS) {
      const page = await login(browser, user, "fr", mode.viewport, mode.scheme);
      const nav = page.locator("nav[aria-label='principal'] button");
      for (let i = 0; i < (await nav.count()); i += 1) {
        await nav.nth(i).click();
        await page.waitForTimeout(900);
        const tabs = page.locator("main .subtabs button");
        const tc = await tabs.count();
        for (let j = 0; j < Math.max(1, tc); j += 1) {
          if (tc) {
            await tabs.nth(j).click();
            await page.waitForTimeout(600);
          }
          const row = page.locator("main button.row, main [data-stay]").first();
          if (await row.count()) await row.click().catch(() => {});
          await page.waitForTimeout(500);
          await page.screenshot({
            path: `${SHOTS}/ui-${mode.n}-${user.replace("dev-", "")}-${i}${tc ? `-${j}` : ""}.png`,
            fullPage: true,
          });
        }
      }
      await page.context().close();
    }
  }
} finally {
  await browser.close();
}
