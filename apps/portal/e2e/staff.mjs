// Écrans du personnel, dans un vrai navigateur : fiche d'agent, diplôme, planning de garde de 8 à 10 h (refus de chevauchement, de
// repos de 24 h et de durée hors limites, aucune licence exigée), congé demandé par l'agent et décidé par les ressources humaines, suspension qui coupe le compte.
import assert from "node:assert/strict";
import { api, chromium, kcAdmin, login, PORTAL, shot, sleep, token } from "./lib.mjs";

const suffix = String(Date.now()).slice(-6);
const day = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

const browser = await chromium.launch();
try {
  // Rejouable : le compte de test est remis en état (réactivé dans Keycloak, agent réactivé puis détaché) si une
  // exécution précédente s'est arrêtée pendant la suspension.
  const [kcUser] = await kcAdmin("GET", "/users?username=dev-doctor2&exact=true");
  await kcAdmin("PUT", `/users/${kcUser.id}`, { ...kcUser, enabled: true });
  const sub = kcUser.id;
  for (const m of (await api("dev-hr", "/api/staff", { expect: 200 })).data.staff) {
    if (m.userId !== sub) continue;
    if (m.status === "suspended")
      await api("dev-hr", `/api/staff/${m.id}/status`, {
        method: "POST",
        body: { status: "active", effectiveOn: day(0), reason: "Remise en état du test" },
        expect: 200,
      });
    await api("dev-hr", `/api/staff/${m.id}/unlink`, { method: "POST", expect: 200 });
  }

  const hr = await login(browser, "dev-hr");
  await hr.locator("nav[aria-label='principal'] button:has-text('Personnel')").waitFor();
  assert.equal(
    await hr.locator("nav[aria-label='principal'] button").count(),
    2,
    "RH : personnel et mon espace, aucun dossier de patient",
  );

  /* ------------------------------------------------ fiche d'agent */
  const create = async (given, family, category, title) => {
    await hr.click("button:has-text('Nouvel agent')");
    await hr.fill("label:text-is('Prénom') input", given);
    await hr.fill("label:text-is('Nom') input", family);
    await hr.locator("label:text-is('Catégorie') select").selectOption(category);
    await hr.fill("label:text-is('Fonction') input", title);
    await hr.locator("label:text-is('Service') select").selectOption("CONS");
    await hr.fill("label:text-is('Date d\\'embauche') input", "2021-03-01");
    await hr.click("button:has-text('Créer la fiche')");
    const note = await hr.waitForSelector("[role=status]:has-text('Fiche M-')");
    return (await note.textContent()).match(/M-\d{6}/)[0];
  };
  const doc = await create("Docteure", `Essai${suffix}`, "physician", "Médecin généraliste");
  const panel = hr.locator(`[data-member-panel='${doc}']`);
  await panel.waitFor();

  // Diplôme (informatif : aucune licence d'exercice n'est contrôlée).
  await panel
    .locator("input[aria-label='Intitulé']")
    .fill("Doctorat en médecine (exemple de test)");
  await panel.locator("button:has-text('Ajouter')").click();
  await panel.locator("[data-qualification='Doctorat en médecine (exemple de test)']").waitFor();
  await shot(hr, "40-personnel-fiche");

  // Rattachement du compte de connexion (identifiant Keycloak de dev-doctor2).
  await panel.locator("input[aria-label='Rattacher un compte (identifiant)']").fill(sub);
  await panel.locator("button:has-text('Rattacher')").click();
  await panel.locator(`text=${sub}`).waitFor();

  // Un second agent, sans aucune licence ni diplôme saisi : planifiable (pas de contrôle de licence).
  const nurse = await create("Infirmier", `Sanslicence${suffix}`, "nurse", "Infirmier");

  // Fiche et compte de connexion créés ensemble (compte Keycloak réel, rôle déduit de la catégorie).
  await hr.click("button:has-text('Nouvel agent')");
  await hr.fill("label:text-is('Prénom') input", "Aide");
  await hr.fill("label:text-is('Nom') input", `Soignante${suffix}`);
  await hr.locator("label:text-is('Catégorie') select").selectOption("care_assistant");
  await hr.fill("label:text-is('Fonction') input", "Aide-soignante");
  await hr.fill("label:text-is('Date d\\'embauche') input", "2024-02-01");
  await hr.check("[data-create-account]");
  await hr.fill("label:has-text('Identifiant du compte') input", `aide.${suffix}`);
  await hr.fill("label:has-text('Adresse e-mail') input", `aide.${suffix}@chu.invalid`);
  await hr.fill("label:has-text('Mot de passe temporaire') input", `Temporaire-${suffix}-Aa1`);
  await hr.click("button:has-text('Créer la fiche')");
  const aidePanel = hr.locator(`[data-member-panel]:not([data-member-panel='${nurse}'])`);
  await aidePanel.waitFor();
  const aide = await aidePanel.getAttribute("data-member-panel");
  await hr
    .locator(`[data-member-panel='${aide}']`)
    .locator("text=/Rattacher un compte \\(identifiant\\) : [0-9a-f-]{36}/")
    .waitFor();
  const created = (await api("dev-hr", "/api/staff", { expect: 200 })).data.staff.find(
    (m) => m.matricule === aide,
  );
  assert.match(created.userId, /^[0-9a-f-]{36}$/, "compte Keycloak créé et rattaché");

  /* ------------------------------------------------ planning */
  await hr.click("[data-tab='roster']");
  await hr.locator("select[aria-label='Service']").selectOption("CONS");
  await hr.locator("label:text-is('Semaine du') input").fill(day(0));
  const plan = async (who, date, start, end) => {
    await hr.locator("select[aria-label='Agent']").selectOption({ label: who });
    await hr.fill("label:text-is('Date') input", date);
    await hr.fill("label:text-is('Début (heure)') input", String(start));
    await hr.fill("label:text-is('Fin (heure)') input", String(end));
    await hr.click("button:has-text('Planifier la garde')");
  };
  const docLabel = `Docteure Essai${suffix} (${doc})`;
  await plan(docLabel, day(2), 8, 16);
  await hr.locator("[role=status]:has-text('Garde planifiée')").waitFor();
  await hr.locator(`tr[data-shift='Docteure Essai${suffix}']`).waitFor();
  await plan(docLabel, day(2), 12, 20);
  await hr.locator("[role=alert]:has-text('déjà de garde')").waitFor();
  await plan(docLabel, day(3), 8, 16); // 16 h après la fin de la garde précédente : repos de 24 h non respecté
  await hr.locator("[role=alert]:has-text('Repos minimal')").waitFor();
  await plan(docLabel, day(6), 8, 14); // 6 h : hors des 8 à 10 heures
  await hr.locator("[role=alert]:has-text('dure de 8 à 10 heures')").waitFor();
  await plan(`Infirmier Sanslicence${suffix} (${nurse})`, day(2), 8, 16);
  await hr.locator("[role=status]:has-text('Garde planifiée')").waitFor();
  await shot(hr, "41-planning");

  /* ------------------------------------------------ congé demandé par l'agent */
  const agent = await login(browser, "dev-doctor2");
  await agent.locator("nav[aria-label='principal'] button:has-text('Mon espace')").click();
  const mine = agent.locator(`[data-my-record='${doc}']`);
  await mine.waitFor();
  await mine.locator("[data-my-shifts] li").first().waitFor();
  await agent.locator("label:text-is('Du') input").fill(day(1));
  await agent.locator("label:text-is('Au') input").fill(day(4));
  await agent.locator("label:text-is('Motif') input").fill("Congé annuel");
  await agent.click("button:has-text('Demander le congé')");
  await agent.locator("[role=status]:has-text('Demande envoyée')").waitFor();
  await agent.locator("[data-leave-status='requested']").waitFor();

  // Les ressources humaines : la garde sur la période bloque l'approbation ; on la retire puis on approuve.
  await hr.click("[data-tab='leaves']");
  const leave = hr.locator(`[data-leave='Docteure Essai${suffix}']`);
  await leave.waitFor();
  await leave.locator("input").fill("Accord du chef de service");
  await leave.locator("button:has-text('Approuver')").click();
  await leave
    .locator("[role=alert], ~ [role=alert]")
    .first()
    .waitFor()
    .catch(() => null);
  await hr.locator("[role=alert]:has-text('gardes sont planifiées')").waitFor();
  await hr.click("[data-tab='roster']");
  await hr.locator("select[aria-label='Service']").selectOption("CONS");
  await hr.locator("label:text-is('Semaine du') input").fill(day(0));
  await hr
    .locator(`tr[data-shift='Docteure Essai${suffix}'] button:has-text('Retirer la garde')`)
    .click();
  await hr.locator(`tr[data-shift='Docteure Essai${suffix}']`).waitFor({ state: "detached" });
  await hr.click("[data-tab='leaves']");
  const again = hr.locator(`[data-leave='Docteure Essai${suffix}']`);
  await again.locator("input").fill("Accord du chef de service");
  await again.locator("button:has-text('Approuver')").click();
  await again.waitFor({ state: "detached" });
  await agent.reload();
  await agent.locator("nav[aria-label='principal'] button:has-text('Mon espace')").click();
  await agent.locator("[data-leave-status='approved']").waitFor();
  await shot(agent, "42-mon-espace");

  // Deux autres demandes : l'agent en annule une lui-même, les ressources humaines refusent l'autre (motif).
  const ask = async (from, to, why) => {
    await agent.locator("label:text-is('Du') input").fill(day(from));
    await agent.locator("label:text-is('Au') input").fill(day(to));
    await agent.locator("label:text-is('Motif') input").fill(why);
    await agent.click("button:has-text('Demander le congé')");
    await agent.locator("[role=status]:has-text('Demande envoyée')").waitFor();
  };
  await ask(20, 21, "Congé à annuler");
  await agent
    .locator("[data-leave-status='requested'] button:has-text('Annuler la demande')")
    .click();
  await agent.locator("[data-leave-status='cancelled']").waitFor();
  await ask(30, 31, "Congé à refuser");
  await hr.click("[data-tab='members']");
  await hr.click("[data-tab='leaves']");
  const toRefuse = hr.locator(`[data-leave='Docteure Essai${suffix}']`);
  await toRefuse.waitFor();
  await toRefuse.locator("input").fill("Période de forte activité");
  await toRefuse.locator("button:has-text('Refuser')").click();
  await toRefuse.waitFor({ state: "detached" });
  await agent.reload();
  await agent.locator("nav[aria-label='principal'] button:has-text('Mon espace')").click();
  await agent.locator("[data-leave-status='rejected']").waitFor();

  /* ------------------------------------------------ suspension : le compte est coupé tout de suite */
  await hr.click("[data-tab='members']");
  await hr.fill("input[aria-label='Nom ou matricule']", doc);
  await hr.locator(`button[data-member='${doc}']`).click();
  const p2 = hr.locator(`[data-member-panel='${doc}']`);
  const oldToken = await token("dev-doctor2"); // jeton encore valide au moment de la suspension
  await p2.locator("select[aria-label='Situation']").selectOption("suspended");
  await p2.locator("input[aria-label='Motif']").fill("Procédure disciplinaire en cours");
  await p2.locator("button:has-text('Changer la situation')").click();
  await hr.locator("[role=status]:has-text('Compte : désactivé')").waitFor();
  await agent.reload();
  await agent.locator("[role=alert]:has-text('désactivé')").waitFor();
  const stale = await fetch(`${PORTAL}/api/staff`, {
    headers: { authorization: `Bearer ${oldToken}` },
  });
  assert.equal(stale.status, 403, "l'API refuse un jeton encore valide d'un compte suspendu");
  assert.equal(
    await token("dev-doctor2"),
    undefined,
    "Keycloak refuse aussi toute nouvelle connexion",
  );

  await p2.locator("select[aria-label='Situation']").selectOption("active");
  await p2.locator("input[aria-label='Motif']").fill("Fin de la suspension");
  await p2.locator("button:has-text('Changer la situation')").click();
  await hr.locator("[role=status]:has-text('Compte : rétabli')").waitFor();
  assert.equal((await api("dev-doctor2", "/api/staff")).status, 200, "compte rétabli");
  await sleep(100);

  console.log(
    "OK : personnel (fiche, diplôme, planning 8–10 h, repos 24 h, congé, suspension) vérifié dans le navigateur.",
  );
} finally {
  await browser.close();
}
