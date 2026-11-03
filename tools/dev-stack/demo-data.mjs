/* global process, fetch, URLSearchParams, console */
/* eslint-disable no-console */
// Données d'exemple FICTIVES pour la recette en ligne : catalogues, plages de référence, quelques patients, caisse ouverte.
// Sans dépendance : utilise seulement fetch. Variables : KEYCLOAK_URL (…/auth ou racine), API_URL, CHU_DEV_USER_PASSWORD.
const KC = process.env.KEYCLOAK_URL ?? "http://localhost:8081/auth";
const API = process.env.API_URL ?? "http://localhost:3100";
const PASSWORD = process.env.CHU_DEV_USER_PASSWORD;
if (!PASSWORD) throw new Error("CHU_DEV_USER_PASSWORD est obligatoire");

const token = async (user) =>
  (
    await (
      await fetch(`${KC}/realms/chu/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "chu-dev-cli",
          username: user,
          password: PASSWORD,
        }),
      })
    ).json()
  ).access_token;
const call = async (user, path, { method = "GET", body, csv } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(user)}`,
      ...(csv
        ? { "content-type": "text/csv" }
        : body
          ? { "content-type": "application/json" }
          : {}),
    },
    body: csv ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} : ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const R = "Responsable démo,2026-11-01";
const csvs = {
  "/api/catalog/payers/import": `code,libelle_fr,libelle_ar,part_patient,responsable,date_maj\nDIRECT,Paiement direct,دفع مباشر,1,${R}\nGRATUIT,Ministère (gratuité),الوزارة (مجاني),0,${R}\n`,
  "/api/catalog/acts/import": `code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj\nCONS-GEN,Consultation générale,استشارة عامة,2000,CONS,consultation,${R}\nLAB-GLY,Glycémie,سكر الدم,1500,LAB,laboratoire,${R}\nLAB-NFS,Hémogramme,تعداد الدم,2500,LAB,laboratoire,${R}\nIMG-RX,Radiographie,تصوير بالأشعة,6000,IMG,imagerie,${R}\nHOSP-1J,Hospitalisation par jour,إيواء ليوم واحد,10000,HOSP,hospitalisation,${R}\nHOSP-SOIN,Soins infirmiers du jour,رعاية تمريضية يومية,2000,HOSP,hospitalisation,${R}\nCHIR-INI,Opération initiale (exemple),عملية أولية,50000,HOSP,autre,${R}\n`,
  "/api/catalog/diagnoses/import": `code,libelle_fr,libelle_ar\nE11,Diabète de type 2 (exemple),داء السكري من النوع 2 (مثال)\nJ06,Infection aiguë des voies respiratoires supérieures (exemple),التهاب الجهاز التنفسي العلوي (مثال)\nB50,Paludisme à Plasmodium falciparum (exemple),ملاريا المتصورة المنجلية (مثال)\n`,
  "/api/catalog/drugs/import": `code,dci,forme,dosage,libelle_ar,classe_allergie,classe_interaction,responsable,date_maj\nAMO-500,Amoxicilline,Gélule,500 mg,أموكسيسيلين,penicillin,,Pharmacien démo,2026-11-01\nPAR-500,Paracétamol,Comprimé,500 mg,باراسيتامول,,,Pharmacien démo,2026-11-01\n`,
};
for (const [path, csv] of Object.entries(csvs))
  await call("dev-admin", path, { method: "POST", csv });
await call("dev-biologist", "/api/lab/tests/import", {
  method: "POST",
  csv: `code,loinc,act_code,libelle_fr,libelle_ar,echantillon,unite,type_valeur,responsable,date_maj\nGLY,2345-7,LAB-GLY,Glycémie,سكر الدم,Sérum,mmol/L,numeric,Biologiste démo,2026-11-01\n`,
});
await call("dev-biologist", "/api/lab/tests/GLY/ranges", {
  method: "PUT",
  body: {
    ranges: [
      {
        sex: "any",
        ageMinDays: 6570,
        ageMaxDays: 32850,
        criticalLow: 2.2,
        low: 3.9,
        high: 6.1,
        criticalHigh: 25,
      },
    ],
    validatedBy: "Biologiste démo (VALEURS D'EXEMPLE)",
    validatedOn: "2026-11-01",
  },
});
const people = [
  ["Amina", "Hassan", "female", "1990-02-03"],
  ["Omar", "Youssouf", "male", "1985-07-21"],
  ["Fatouma", "Ahmed", "female", "2001-11-30"],
  ["Idriss", "Moussa", "male", "1972-05-14"],
];
for (const [givenName, familyName, sex, birthDate] of people)
  await call("dev-reception", "/api/patients", {
    method: "POST",
    body: { givenName, familyName, sex, birthDate, confirmNotDuplicate: true },
  }).catch(() => {});
console.log("Données d'exemple chargées : catalogues, plages de référence, 4 patients fictifs.");
