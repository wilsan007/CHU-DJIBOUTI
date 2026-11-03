// Écrans du personnel, dans un vrai navigateur : fiche d'agent, licence, planning de garde (refus de chevauchement, de repos
// et de licence), congé demandé par l'agent et décidé par les ressources humaines, suspension qui coupe le compte.
import assert from "node:assert/strict";
import { api, chromium, login, shot, sleep, token } from "./lib.mjs";

const suffix = String(Date.now()).slice(-6);
const day = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
const subOf = async (user) =>
  JSON.parse(Buffer.from((await token(user)).split(".")[1], "base64url").toString()).sub;

const browser = await chromium.launch();
try {
  // Rejouable : le compte de test est détaché de l'agent qui le portait lors d'une exécution précédente.
  const sub = await subOf("dev-doctor2");
  for (const m of (await api("dev-hr", "/api/staff", { expect: 200 })).data.staff)
    if (m.userId === sub)
      await api("dev-hr", `/api/staff/${m.id}/unlink`, { method: "POST", expect: 200 });

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

  // Sans licence d'exercice valide, impossible de planifier (vérifié plus bas). On ajoute la licence.
  await panel.locator("input[aria-label='Intitulé']").fill("Licence d'exercice (exemple de test)");
  await panel.locator("input[aria-label='Expiration']").fill(day(20));
  await panel.locator("button:has-text('Ajouter')").click();
  await panel.locator("[data-qualification='Licence d\\'exercice (exemple de test)']").waitFor();
  await shot(hr, "40-personnel-fiche");

  // Rattachement du compte de connexion (identifiant Keycloak de dev-doctor2).
  await panel.locator("input[aria-label='Rattacher un compte (identifiant)']").fill(sub);
  await panel.locator("button:has-text('Rattacher')").click();
  await panel.locator(`text=${sub}`).waitFor();

  // Un second agent, sans licence : refusé au planning.
  const nurse = await create("Infirmier", `Sanslicence${suffix}`, "nurse", "Infirmier");

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
  await plan(docLabel, day(2), 14, 20);
  await hr.locator("[role=alert]:has-text('déjà de garde')").waitFor();
  await plan(docLabel, day(3), 2, 8); // 10 h après la fin de la garde précédente (16 h) : repos minimal de 11 h non respecté
  await hr.locator("[role=alert]:has-text('Repos minimal')").waitFor();
  await plan(`Infirmier Sanslicence${suffix} (${nurse})`, day(2), 8, 16);
  await hr.locator("[role=alert]:has-text('Licence')").waitFor();
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

  // Licences à renouveler : celle de l'agent expire dans 20 jours.
  await hr.click("[data-tab='licenses']");
  await hr.locator(`[data-expiring='Docteure Essai${suffix}']`).waitFor();

  /* ------------------------------------------------ suspension : le compte est coupé tout de suite */
  await hr.click("[data-tab='members']");
  await hr.fill("input[aria-label='Nom ou matricule']", doc);
  await hr.locator(`button[data-member='${doc}']`).click();
  const p2 = hr.locator(`[data-member-panel='${doc}']`);
  await p2.locator("select[aria-label='Situation']").selectOption("suspended");
  await p2.locator("input[aria-label='Motif']").fill("Procédure disciplinaire en cours");
  await p2.locator("button:has-text('Changer la situation')").click();
  await hr.locator("[role=status]:has-text('Compte : désactivé')").waitFor();
  await agent.reload();
  await agent.locator("[role=alert]:has-text('désactivé')").waitFor();
  assert.equal(
    (await api("dev-doctor2", "/api/staff")).status,
    403,
    "l'API refuse aussi le compte suspendu",
  );

  await p2.locator("select[aria-label='Situation']").selectOption("active");
  await p2.locator("input[aria-label='Motif']").fill("Fin de la suspension");
  await p2.locator("button:has-text('Changer la situation')").click();
  await hr.locator("[role=status]:has-text('Compte : rétabli')").waitFor();
  assert.equal((await api("dev-doctor2", "/api/staff")).status, 200, "compte rétabli");
  await sleep(100);

  console.log(
    "OK : personnel (fiche, licence, planning, congé, suspension) vérifié dans le navigateur.",
  );
} finally {
  await browser.close();
}
