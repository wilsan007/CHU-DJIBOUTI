// Imagerie DICOM avec un vrai Orthanc : la liste de travail écrite par le noyau est lue par Orthanc (requête DICOM
// réelle), une image envoyée comme le ferait l'appareil est rattachée à l'examen par son accession, une image d'un
// autre patient avec la même accession est refusée à l'affichage, et le médecin voit l'image dans le dossier.
// Prérequis : Orthanc (voir infra/orthanc/README.md) et l'API démarrée avec ORTHANC_URL, ORTHANC_USER, ORTHANC_PASSWORD,
// IMAGING_WORKLIST_DIR (dossier partagé avec Orthanc) et PACS_SYNC_INTERVAL_MS=2000.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { api, chromium, importCatalogs, login, shot, sleep } from "./lib.mjs";
import { buildTestImage } from "../../../services/api/src/modules/imaging/dicom.ts";

const ORTHANC = process.env.ORTHANC_URL ?? "http://localhost:8042";
const AUTH = `Basic ${Buffer.from(`${process.env.ORTHANC_USER ?? "chu"}:${process.env.ORTHANC_PASSWORD}`).toString("base64")}`;
const WL = process.env.IMAGING_WORKLIST_DIR;
if (!WL || !process.env.ORTHANC_PASSWORD)
  throw new Error("IMAGING_WORKLIST_DIR et ORTHANC_PASSWORD sont obligatoires");
const suffix = String(Date.now()).slice(-6);
const until = async (fn, what, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`Délai dépassé : ${what}`);
};
const orthanc = async (path, init = {}) => {
  const res = await fetch(`${ORTHANC}${path}`, {
    ...init,
    headers: { authorization: AUTH, ...(init.headers ?? {}) },
  });
  assert.ok(res.ok, `${path} : ${res.status}`);
  return res;
};

await importCatalogs();
await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
const patient = (
  await api("dev-reception", "/api/patients", {
    method: "POST",
    body: {
      givenName: "Dicom",
      familyName: `Éssai${suffix}`,
      sex: "female",
      birthDate: "1975-08-09",
      phone: `0077${suffix}1`,
      confirmNotDuplicate: true,
    },
    expect: 201,
  })
).data;
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
const order = (
  await api("dev-doctor", "/api/service-orders", {
    method: "POST",
    body: {
      patientId: patient.id,
      encounterId: adm.encounter.id,
      items: [{ actCode: "IMG-RX", quantity: 1 }],
    },
    expect: 201,
  })
).data;
const inv = await until(
  async () =>
    (await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${order.number}`))
      .data.invoices[0],
  "facture",
);
await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
  method: "POST",
  body: { method: "cash", receivedAmount: 1_000_000 },
  expect: 200,
});
const request = await until(
  async () =>
    (await api("dev-imaging", `/api/imaging/requests?patientId=${patient.id}`)).data.requests[0],
  "examen créé",
);
assert.match(request.accession, /^ACC-\d{8}$/);
console.log(
  `  ✔ examen ${request.number} créé avec l'accession ${request.accession} dès la libération par la caisse`,
);

// 1. Liste de travail : fichier écrit par le noyau, puis lu par Orthanc comme le ferait un appareil (requête DICOM C-FIND).
await until(() => existsSync(join(WL, `${request.accession}.wl`)), "fichier de liste de travail");
const wl = await (
  await orthanc("/modalities/self/find-worklist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      AccessionNumber: request.accession,
      PatientName: "*",
      PatientID: "*",
      PatientBirthDate: "",
      PatientSex: "*",
      ScheduledProcedureStepSequence: [{ Modality: "CR" }],
    }),
  })
).json();
assert.equal(wl.length, 1, "Orthanc trouve l'élément de liste de travail");
const identifier = patient.identifier;
assert.equal(wl[0].PatientID, identifier);
assert.equal(wl[0].PatientName, `Éssai${suffix}^Dicom`, "nom lu par Orthanc (UTF-8 conservé)");
assert.equal(wl[0].PatientBirthDate, "19750809");
assert.equal(wl[0].PatientSex, "F");
assert.equal(wl[0].ScheduledProcedureStepSequence[0].Modality, "CR");
console.log(
  "  ✔ Orthanc lit la liste de travail (requête DICOM C-FIND) : patient, naissance, sexe, modalité",
);

// 2. L'appareil envoie son image (C-STORE simulé par l'API REST d'Orthanc) avec le bon patient, puis une autre avec un autre patient.
await api("dev-imaging", `/api/imaging/requests/${request.id}/perform`, {
  method: "POST",
  expect: 200,
});
for (const [pid, name] of [
  [identifier, `Éssai${suffix}^Dicom`],
  ["AUTRE-PATIENT", "AUTRE^Patient"],
]) {
  await orthanc("/instances", {
    method: "POST",
    headers: { "content-type": "application/dicom" },
    body: buildTestImage({ patientId: pid, patientName: name, accession: request.accession }),
  });
}
const detail = await until(async () => {
  const d = (await api("dev-imaging", `/api/imaging/requests/${request.id}`)).data;
  return d.studies.length === 2 ? d : null;
}, "études rattachées");
assert.equal(detail.studies.filter((s) => s.patientMatch).length, 1);
assert.equal(detail.studies.find((s) => s.patientMatch).instanceCount, 1);
console.log(
  "  ✔ deux études retrouvées par accession : une du bon patient, une signalée (autre identifiant)",
);

// 3. Écran de l'imagerie : aperçu réel d'Orthanc, étude suspecte non affichée.
const browser = await chromium.launch();
try {
  const tech = await login(browser, "dev-imaging");
  await tech.click("nav[aria-label='principal'] button:has-text('Imagerie')");
  const card = tech.locator(`[data-exam='${request.number}']`);
  await card.waitFor();
  const ok = card.locator("[data-study][data-match='true']");
  await ok.locator("button:has-text('Voir les images')").click();
  await ok.locator("img").waitFor();
  const w = await ok
    .locator("img")
    .evaluate(
      (i) =>
        new Promise((r) => (i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))),
    );
  assert.equal(w, 32, "image PNG de 32 px rendue par Orthanc");
  assert.equal(
    await card.locator("[data-study][data-match='false'] button").count(),
    0,
    "pas de bouton pour l'étude d'un autre patient",
  );
  assert.ok(
    (await card.locator("[data-study][data-match='false']").textContent()).includes(
      "Identifiant patient différent",
    ),
  );
  await shot(tech, "dicom-1-imaging");
  await card
    .locator("label:has-text('Description') textarea")
    .fill("Pas de lésion (exemple de test).");
  await card.locator("label:has-text('Conclusion') textarea").fill("Normal (exemple).");
  await card.locator("button:has-text('Enregistrer le compte rendu')").click();
  await card.waitFor({ state: "detached" });

  // 4. Le médecin lit le compte rendu et voit l'image dans le dossier du patient.
  const doc = await login(browser, "dev-doctor");
  await doc.click("nav[aria-label='principal'] button:has-text('Médecin')");
  await doc.locator("button.row", { hasText: `Éssai${suffix}` }).click();
  const rep = doc.locator("[data-imaging-report]");
  await rep.waitFor({ timeout: 15000 });
  await rep.locator("[data-study][data-match='true'] button:has-text('Voir les images')").click();
  await rep.locator("[data-study][data-match='true'] img").waitFor();
  await shot(doc, "dicom-2-doctor");
  const forged = await api(
    "dev-doctor",
    `/api/imaging/studies/${detail.studies.find((s) => !s.patientMatch).id}/instances`,
  );
  assert.equal(forged.status, 409);
  console.log(
    "  ✔ écran imagerie et dossier du médecin : aperçu réel affiché, étude suspecte refusée (409)",
  );
} finally {
  await browser.close();
}

// 5. La liste de travail est retirée une fois l'examen rapporté.
await until(() => !existsSync(join(WL, `${request.accession}.wl`)), "liste de travail retirée");
console.log("  ✔ liste de travail retirée après le compte rendu");
console.log("OK : imagerie DICOM vérifiée avec un vrai Orthanc.");
