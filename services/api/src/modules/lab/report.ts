import type { PatientSummary } from "../identity/interface.ts";

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const FLAG: Record<string, string> = {
  normal: "",
  none: "",
  low: "B (bas)",
  high: "H (haut)",
  critical_low: "CRITIQUE bas",
  critical_high: "CRITIQUE haut",
};

export interface ReportResult {
  labelFr: string;
  labelAr: string;
  loinc: string;
  value: number | string | null;
  unit: string | null;
  flag: string;
  refLow: number | null;
  refHigh: number | null;
  validatedAt: string | null;
}

/** Compte rendu bilingue : uniquement des résultats validés. */
export function renderReport(input: {
  number: string;
  patient: PatientSummary | null;
  prescriber: string;
  results: ReportResult[];
}): string {
  const rows = input.results
    .map((r) => {
      const ref =
        r.refLow !== null || r.refHigh !== null ? `${r.refLow ?? ""} – ${r.refHigh ?? ""}` : "";
      return `<tr><td>${esc(r.labelFr)}<br><span dir="rtl" lang="ar">${esc(r.labelAr)}</span><br><small>LOINC ${esc(r.loinc)}</small></td><td><strong>${esc(String(r.value ?? ""))}</strong> ${esc(r.unit ?? "")}</td><td>${esc(ref)}</td><td>${esc(FLAG[r.flag] ?? "")}</td></tr>`;
    })
    .join("");
  const name = input.patient?.name ?? "—";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Résultats ${esc(input.number)}</title></head><body>
<h2>CHU Djibouti — Laboratoire — Compte rendu ${esc(input.number)}</h2>
<h3 dir="rtl" lang="ar" style="text-align:right">مستشفى جيبوتي الجامعي — المختبر — نتائج التحاليل</h3>
<p>Patient / المريض : ${esc(name)} (${esc(input.patient?.identifier ?? "")}) · Prescripteur / الطبيب : ${esc(input.prescriber)}</p>
<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>Analyse / التحليل</th><th>Résultat / النتيجة</th><th>Référence / المرجع</th><th>Drapeau</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}
