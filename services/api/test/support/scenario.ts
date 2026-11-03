import assert from "node:assert/strict";
import type { Role } from "../../src/auth/permissions.ts";
import type { TestApp } from "./app.ts";

/** Catalogues FICTIFS pour les tests : tarifs et payeurs d'exemple, sans valeur réelle. */
export const ACTS_CSV = `code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj
CONS-GEN,Consultation générale,استشارة عامة,2000,CONS,consultation,Responsable test,2026-11-01
CONS-SPE,Consultation spécialisée,استشارة متخصصة,5000,CONS,consultation,Responsable test,2026-11-01
LAB-GLY,Glycémie,سكر الدم,1500,LAB,laboratoire,Responsable test,2026-11-01
LAB-NFS,Hémogramme,تعداد الدم,2500,LAB,laboratoire,Responsable test,2026-11-01
IMG-RX,Radiographie,تصوير بالأشعة,6000,IMG,imagerie,Responsable test,2026-11-01
HOSP-1J,Hospitalisation par jour,إيواء ليوم واحد,10000,HOSP,hospitalisation,Responsable test,2026-11-01
`;

export const PAYERS_CSV = `code,libelle_fr,libelle_ar,part_patient,responsable,date_maj
DIRECT,Paiement direct,دفع مباشر,1,Responsable test,2026-11-01
ASSUR,Assurance,تأمين,20%,Responsable test,2026-11-01
GRATUIT,Ministère (gratuité),الوزارة (مجاني),0,Responsable test,2026-11-01
`;

export interface Caller {
  (
    role: Role,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    sub?: string,
  ): Promise<{
    status: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: any;
    raw: string;
  }>;
}

export function makeCaller(t: TestApp): Caller {
  return async (role, method, url, payload, sub) => {
    const token = await t.token([role], sub ? { sub } : {});
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: string | object | undefined;
    if (typeof payload === "string") {
      headers["content-type"] = "text/csv";
      body = payload;
    } else if (payload !== undefined) {
      body = payload as object;
    }
    const res = await t.app.inject({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { payload: body }),
    });
    const parsed: unknown = (() => {
      try {
        return res.json();
      } catch {
        return null;
      }
    })();
    return { status: res.statusCode, body: parsed, raw: res.body };
  };
}

let phone = 0;
export async function importCatalogs(call: Caller): Promise<void> {
  const payers = await call("admin", "POST", "/api/catalog/payers/import", PAYERS_CSV);
  assert.equal(payers.status, 200, payers.raw);
  const acts = await call("admin", "POST", "/api/catalog/acts/import", ACTS_CSV);
  assert.equal(acts.status, 200, acts.raw);
  assert.equal(acts.body.rejected.length, 0, acts.raw);
}

export async function newPatient(
  call: Caller,
  name = "Patient",
): Promise<{ id: string; identifier: string }> {
  phone += 1;
  const res = await call("reception", "POST", "/api/patients", {
    givenName: name,
    familyName: `Test${phone}`,
    sex: "female",
    birthDate: "1985-04-12",
    phone: `00 55 ${String(Math.floor(phone / 100)).padStart(2, "0")} ${String(phone % 100).padStart(2, "0")}`,
    confirmNotDuplicate: true,
  });
  assert.equal(res.status, 201, res.raw);
  return res.body;
}

export async function admitPatient(
  call: Caller,
  patientId: string,
  options: { department?: string; payer?: string; act?: string } = {},
) {
  const res = await call("reception", "POST", "/api/admissions", {
    patientId,
    departmentCode: options.department ?? "CONS",
    payerCode: options.payer ?? "DIRECT",
    actCode: options.act ?? "CONS-GEN",
  });
  assert.equal(res.status, 201, res.raw);
  return res.body as {
    encounter: { id: string };
    invoice: {
      id: string;
      number: string;
      patientAmount: number;
      payerAmount: number;
      total: number;
    };
  };
}

export async function openCash(call: Caller, sub?: string) {
  const res = await call("cashier", "POST", "/api/billing/cash-sessions/open", undefined, sub);
  assert.equal(res.status, 201, res.raw);
  return res.body as { id: string };
}

/** Listes FICTIVES pour les tests cliniques : ni liste CIM-10 officielle ni catalogue réel. */
export const DIAGNOSES_CSV = `code,libelle_fr,libelle_ar
E11,Diabète sucré de type 2,داء السكري من النوع 2
I10,Hypertension essentielle,ارتفاع ضغط الدم الأساسي
J06,Infection aiguë des voies respiratoires supérieures,عدوى حادة في الجهاز التنفسي العلوي
B50,Paludisme à Plasmodium falciparum,ملاريا المتصورة المنجلية
N39.0,Infection urinaire,عدوى المسالك البولية
`;

export const DRUGS_CSV = `code,dci,forme,dosage,libelle_ar,classe_allergie,classe_interaction,responsable,date_maj
AZI-250,Azithromycine,Comprimé,250 mg,أزيثرومايسين,,,Pharmacien test,2026-11-01
AMO-500,Amoxicilline,Gélule,500 mg,أموكسيسيلين,penicillin,,Pharmacien test,2026-11-01
PAR-500,Paracétamol,Comprimé,500 mg,باراسيتامول,,,Pharmacien test,2026-11-01
MET-500,Metformine,Comprimé,500 mg,ميتفورمين,,,Pharmacien test,2026-11-01
WAR-5,Warfarine,Comprimé,5 mg,,,anticoagulant,Pharmacien test,2026-11-01
IBU-400,Ibuprofène,Comprimé,400 mg,,,nsaid,Pharmacien test,2026-11-01
`;

export async function importClinicalCatalogs(call: Caller): Promise<void> {
  const d = await call("admin", "POST", "/api/catalog/diagnoses/import", DIAGNOSES_CSV);
  assert.equal(d.status, 200, d.raw);
  const m = await call("admin", "POST", "/api/catalog/drugs/import", DRUGS_CSV);
  assert.equal(m.status, 200, m.raw);
  assert.equal(m.body.rejected.length, 0, m.raw);
  // Posologie standard validée (exemple de test) et interaction grave listée par un « comité » fictif.
  const dose = await call("admin", "POST", "/api/catalog/drugs/PAR-500/standard-dosages", {
    dose: 1,
    perDay: 3,
    days: 3,
    route: "oral",
    validatedBy: "Pharmacien test",
    validatedOn: "2026-11-01",
  });
  assert.equal(dose.status, 201, dose.raw);
  const inter = await call("admin", "PUT", "/api/catalog/interactions", {
    classA: "nsaid",
    classB: "anticoagulant",
    messageFr: "Interaction grave (exemple de test) : risque hémorragique.",
    messageAr: "تداخل خطير (مثال اختبار) : خطر النزف.",
    validatedBy: "Comité test",
    validatedOn: "2026-11-01",
  });
  assert.equal(inter.status, 200, inter.raw);
}

/** Admission puis ouverture d'une consultation par un médecin. */
export async function startConsultation(call: Caller, doctorSub = "dr-1", name = "Patient") {
  const patient = await newPatient(call, name);
  const admission = await admitPatient(call, patient.id);
  const res = await call(
    "doctor",
    "POST",
    "/api/consultations",
    { patientId: patient.id, encounterId: admission.encounter.id },
    doctorSub,
  );
  assert.equal(res.status, 201, res.raw);
  return {
    patient,
    encounterId: admission.encounter.id,
    consultation: res.body as { id: string; version: number },
  };
}
