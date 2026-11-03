// Outils communs des tests de bout en bout : jetons Keycloak, appels d'API, connexion dans le navigateur.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

export const PORTAL = process.env.PORTAL_URL ?? "http://localhost:8080";
export const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8081";
export const PASSWORD = process.env.CHU_DEV_USER_PASSWORD;
export const SHOTS = process.env.SHOTS_DIR;
if (!PASSWORD) throw new Error("CHU_DEV_USER_PASSWORD est obligatoire");

export async function token(user) {
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

/** Appel direct de l'API (préparation des données, vérifications) en tant que `user` (compte dev-*). */
export async function api(user, path, { method = "GET", body, csv, expect } = {}) {
  const headers = { authorization: `Bearer ${await token(user)}` };
  if (csv !== undefined) headers["content-type"] = "text/csv";
  else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${PORTAL}${path}`, {
    method,
    headers,
    body: csv ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (expect !== undefined) assert.equal(res.status, expect, `${method} ${path} : ${text}`);
  return { status: res.status, data };
}

export async function login(browser, user, lang = "fr", viewport = { width: 1200, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((l) => {
    try {
      localStorage.setItem("lang", l);
    } catch {
      // sans importance
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

export const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ACTS_CSV = `code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj
CONS-GEN,Consultation générale,استشارة عامة,2000,CONS,consultation,Responsable test,2026-11-01
LAB-GLY,Glycémie,سكر الدم,1500,LAB,laboratoire,Responsable test,2026-11-01
IMG-RX,Radiographie,تصوير بالأشعة,6000,IMG,imagerie,Responsable test,2026-11-01
`;
export const PAYERS_CSV = `code,libelle_fr,libelle_ar,part_patient,responsable,date_maj
DIRECT,Paiement direct,دفع مباشر,1,Responsable test,2026-11-01
`;
export const DIAGNOSES_CSV = `code,libelle_fr,libelle_ar
E11,Diabète de type 2 (exemple de test),داء السكري من النوع 2 (مثال اختبار)
J06,Infection aiguë des voies respiratoires supérieures (exemple de test),التهاب الجهاز التنفسي العلوي (مثال اختبار)
`;
export const DRUGS_CSV = `code,dci,forme,dosage,libelle_ar,classe_allergie,classe_interaction,responsable,date_maj
AMO-500,Amoxicilline,Gélule,500 mg,أموكسيسيلين,penicillin,,Pharmacien test,2026-11-01
PAR-500,Paracétamol,Comprimé,500 mg,باراسيتامول,,,Pharmacien test,2026-11-01
`;
export const LAB_TESTS_CSV = `code,loinc,act_code,libelle_fr,libelle_ar,echantillon,unite,type_valeur,responsable,date_maj
GLY,2345-7,LAB-GLY,Glycémie,سكر الدم,Sérum,mmol/L,numeric,Biologiste test,2026-11-01
`;

/** Catalogues FICTIFS de test, chargés par les comptes qui en ont le droit (idempotent). */
export async function importCatalogs() {
  await api("dev-admin", "/api/catalog/payers/import", {
    method: "POST",
    csv: PAYERS_CSV,
    expect: 200,
  });
  await api("dev-admin", "/api/catalog/acts/import", {
    method: "POST",
    csv: ACTS_CSV,
    expect: 200,
  });
  await api("dev-admin", "/api/catalog/diagnoses/import", {
    method: "POST",
    csv: DIAGNOSES_CSV,
    expect: 200,
  });
  await api("dev-admin", "/api/catalog/drugs/import", {
    method: "POST",
    csv: DRUGS_CSV,
    expect: 200,
  });
  await api("dev-biologist", "/api/lab/tests/import", {
    method: "POST",
    csv: LAB_TESTS_CSV,
    expect: 200,
  });
}

export const cardPayload = async (patientId) =>
  (await api("dev-reception", `/api/patients/${patientId}/card`, { expect: 200 })).data.payload;

/** Administration Keycloak (compte de service `chu-admin-api`) : remise en état des comptes de test entre deux exécutions. */
export async function kcAdmin(method, path, body) {
  const secret = process.env.CHU_ADMIN_CLIENT_SECRET;
  if (!secret) throw new Error("CHU_ADMIN_CLIENT_SECRET est obligatoire");
  const t = await (
    await fetch(`${KEYCLOAK}/realms/chu/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "chu-admin-api",
        client_secret: secret,
      }),
    })
  ).json();
  const res = await fetch(`${KEYCLOAK}/admin/realms/chu${path}`, {
    method,
    headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Remise à zéro des alertes de valeur critique d'un compte (les scénarios précédents en laissent) pour que le test ne lise que les siennes. */
export async function clearCriticalNotifications(user) {
  const { data } = await api(user, "/api/lab/notifications?open=true");
  for (const n of data?.notifications ?? [])
    await api(user, `/api/lab/notifications/${n.id}/acknowledge`, { method: "POST", body: {} });
}
