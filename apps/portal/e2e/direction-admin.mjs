// Tableau de bord de direction et administration des comptes, dans un vrai navigateur.
import assert from "node:assert/strict";
import { api, chromium, kcAdmin, login, PORTAL, shot, sleep, token } from "./lib.mjs";

const suffix = String(Date.now()).slice(-6);
const digits = (s) => Number(String(s).replace(/\D/g, ""));
const browser = await chromium.launch();
try {
  // ---------- Direction ----------
  const dir = await login(browser, "dev-direction");
  assert.equal(
    await dir.locator("nav[aria-label='principal'] button:has-text('Comptes')").count(),
    0,
    "pas d'administration pour la direction",
  );
  await dir.locator("[data-tile='collected']").waitFor();
  const date = await dir.locator("input[type='date']").inputValue();
  const d = (await api("dev-direction", `/api/dashboard?date=${date}`, { expect: 200 })).data;
  const tile = async (id) => (await dir.locator(`[data-tile='${id}']`).textContent()) ?? "";
  assert.equal(digits(await tile("collected")), d.revenue.collected, "encaissements");
  assert.equal(digits(await tile("net")), d.revenue.net, "net");
  assert.equal(digits(await tile("ordersPlaced")), d.activity.ordersPlaced, "demandes");
  assert.equal(digits(await tile("admissions")), d.activity.admissions, "admissions");
  assert.equal(
    await tile("occupiedBeds").then((x) =>
      x
        .match(/(\d+)\s*\/\s*(\d+)/)
        ?.slice(1)
        .map(Number)
        .join("/"),
    ),
    `${d.hospitalization.occupiedBeds}/${d.hospitalization.totalBeds}`,
    "lits occupés",
  );
  assert.equal(digits(await tile("staffActive")), d.staff.active, "agents actifs");
  await shot(dir, "direction-1");

  // Aucun nom de patient, aucun identifiant de dossier : uniquement des chiffres.
  const text = await dir.locator("section").textContent();
  assert.ok(!/Essai\d+/.test(text), "aucun nom de patient sur le tableau de bord");

  // Autre date : un jour sans activité donne des zéros, pas une erreur.
  await dir.locator("input[type='date']").fill("2020-01-01");
  await dir.locator("[data-tile='admissions']:has-text('0')").waitFor();
  assert.equal(digits(await tile("collected")), 0);

  // Arabe : tuiles présentes, sens de lecture inversé.
  await dir.click("button:has-text('العربية')");
  await dir.locator("html[dir='rtl']").waitFor();
  await shot(dir, "direction-2-ar");

  // Le médecin n'y a pas accès (API).
  assert.equal((await api("dev-doctor", "/api/dashboard", {})).status, 403);

  // ---------- Administration ----------
  const [kcUser] = await kcAdmin("GET", "/users?username=dev-doctor2&exact=true");
  await kcAdmin("PUT", `/users/${kcUser.id}`, { ...kcUser, enabled: true });
  // Le compte doit être « connu » : il s'est connecté au moins une fois.
  const agent = await login(browser, "dev-doctor2");
  await agent.close();

  const adm = await login(browser, "dev-admin");
  await adm.click("nav[aria-label='principal'] button:has-text('Comptes')");
  const row = adm.locator("[data-user='dev-doctor2']");
  await row.waitFor();
  assert.equal(await row.getAttribute("data-status"), "active");
  await shot(adm, "admin-1");

  // Désactivation : motif obligatoire (bouton inactif sans motif), coupure réelle de l'accès.
  assert.equal(await row.locator("button:has-text('Désactiver')").isDisabled(), true);
  const oldToken = await token("dev-doctor2");
  await row.locator("input[aria-label='Motif (obligatoire)']").fill("Départ en congé sans solde");
  await row.locator("button:has-text('Désactiver')").click();
  await adm.locator("[data-user='dev-doctor2'][data-status='disabled']").waitFor();
  const stale = await fetch(`${PORTAL}/api/me`, {
    headers: { authorization: `Bearer ${oldToken}` },
  });
  assert.equal(stale.status, 403, "jeton encore valide refusé");
  assert.equal(await token("dev-doctor2"), undefined, "Keycloak refuse la connexion");
  await shot(adm, "admin-2-disabled");

  // Réactivation.
  await row.locator("button:has-text('Réactiver')").click();
  await adm.locator("[data-user='dev-doctor2'][data-status='active']").waitFor();
  assert.equal((await api("dev-doctor2", "/api/me", {})).status, 200, "accès rétabli");

  // Changement de rôle puis retour au rôle d'origine.
  await row.locator("select[aria-label='Rôle']").selectOption("nurse");
  await row.locator("button:has-text('Changer le rôle')").click();
  await adm.locator("[role=status]:has-text('Rôle modifié')").waitFor();
  const me = (await api("dev-doctor2", "/api/me", { expect: 200 })).data;
  assert.ok(
    me.roles.includes("nurse") && !me.roles.includes("doctor"),
    `rôle changé : ${me.roles}`,
  );
  await row.locator("select[aria-label='Rôle']").selectOption("doctor");
  await row.locator("button:has-text('Changer le rôle')").click();
  await sleep(1000);
  assert.ok((await api("dev-doctor2", "/api/me", { expect: 200 })).data.roles.includes("doctor"));

  // Création d'un compte réel dans Keycloak.
  const username = `e2e-${suffix}`;
  await adm.fill("label:text-is('Identifiant') input", username);
  await adm.fill("label:text-is('Adresse e-mail') input", `${username}@example.org`);
  await adm.locator("label:text-is('Rôle') select").selectOption("reception");
  await adm.fill("label:has-text('Mot de passe temporaire') input", "Temporaire-Essai-2026!");
  await adm.click("button:has-text('Créer le compte')");
  await adm.locator(`[role=status]:has-text('${username}')`).waitFor();
  const created = await kcAdmin("GET", `/users?username=${username}&exact=true`);
  assert.equal(created.length, 1, "compte créé dans Keycloak");
  await kcAdmin("DELETE", `/users/${created[0].id}`);

  // Les autres rôles n'ont pas l'écran.
  assert.equal((await api("dev-doctor", "/api/admin/users", {})).status, 403);
  console.log("OK direction + administration");
} finally {
  await browser.close();
}
