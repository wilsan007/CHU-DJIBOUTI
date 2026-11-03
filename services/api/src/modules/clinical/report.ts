import type { PatientSummary } from "../identity/interface.ts";
import type { Consultation } from "./service.ts";

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

const VITAL_LABELS: Record<string, { fr: string; ar: string }> = {
  weight: { fr: "Poids", ar: "الوزن" },
  height: { fr: "Taille", ar: "الطول" },
  systolic: { fr: "Tension systolique", ar: "الضغط الانقباضي" },
  diastolic: { fr: "Tension diastolique", ar: "الضغط الانبساطي" },
  temperature: { fr: "Température", ar: "الحرارة" },
  pulse: { fr: "Pouls", ar: "النبض" },
  spo2: { fr: "Saturation en oxygène", ar: "تشبع الأكسجين" },
};

/**
 * Compte rendu bilingue (français à gauche, arabe à droite) : une page HTML autonome, imprimable ou
 * convertible en PDF par le navigateur. Il est archivé tel quel dans le dossier et ne change plus.
 */
export function renderReport(input: {
  consultation: Consultation;
  patient: PatientSummary | null;
  practitionerName: string;
}): string {
  const c = input.consultation;
  const date = c.openedAt.slice(0, 10);
  const vitals = (c.vitals ?? []).map((v) => {
    const l = VITAL_LABELS[v.kind] ?? { fr: v.kind, ar: v.kind };
    return { fr: `${l.fr} : ${v.value} ${v.unit}`, ar: `${l.ar} : ${v.value} ${v.unit}` };
  });
  const dx = c.diagnoses ?? [];
  const list = (items: string[]) =>
    items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "<p>—</p>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Compte rendu ${esc(date)}</title></head><body>
<table width="100%"><tr>
<td valign="top" width="50%"><h2>CHU Djibouti — Compte rendu de consultation</h2>
<p>Date : ${esc(date)}<br>Patient : ${esc(input.patient?.name ?? "—")} (${esc(input.patient?.identifier ?? "—")})<br>Praticien : ${esc(input.practitionerName)}</p>
<h3>Motif</h3><p>${esc(c.reason) || "—"}</p><h3>Examen</h3><p>${esc(c.exam) || "—"}</p>
<h3>Constantes</h3>${list(vitals.map((v) => v.fr))}
<h3>Diagnostics (CIM-10)</h3>${list(dx.map((d) => `${d.code} · ${d.labelFr}${d.primary ? " (principal)" : ""}`))}
<h3>Notes</h3><p>${esc(c.notes) || "—"}</p></td>
<td valign="top" width="50%" dir="rtl" lang="ar" style="text-align:right"><h2>مستشفى جيبوتي الجامعي — تقرير الاستشارة</h2>
<p>التاريخ : ${esc(date)}<br>المريض : ${esc(input.patient?.name ?? "—")} (${esc(input.patient?.identifier ?? "—")})<br>الطبيب : ${esc(input.practitionerName)}</p>
<h3>سبب الزيارة</h3><p>${esc(c.reason) || "—"}</p><h3>الفحص</h3><p>${esc(c.exam) || "—"}</p>
<h3>العلامات الحيوية</h3>${list(vitals.map((v) => v.ar))}
<h3>التشخيص (ICD-10)</h3>${list(dx.map((d) => `${d.code} · ${d.labelAr}${d.primary ? " (رئيسي)" : ""}`))}
<h3>ملاحظات</h3><p>${esc(c.notes) || "—"}</p></td>
</tr></table></body></html>`;
}
