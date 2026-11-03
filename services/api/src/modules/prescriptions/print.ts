import { esc } from "../../common/html.ts";
import { qrSvg } from "../../common/qr.ts";
import type { Prescription } from "./service.ts";

const ROUTE: Record<string, { fr: string; ar: string }> = {
  oral: { fr: "voie orale", ar: "فموي" },
  injectable: { fr: "injectable", ar: "حقن" },
  cutaneous: { fr: "cutanée", ar: "موضعي" },
  other: { fr: "autre voie", ar: "طريق آخر" },
};

/** Ordonnance bilingue imprimable, avec le code de vérification (le numéro et sa clé de contrôle). */
export function renderPrescription(input: { prescription: Prescription; payload: string }): string {
  const p = input.prescription;
  const lines = p.lines ?? [];
  const fr = lines
    .map(
      (l) =>
        `<li><strong>${esc(l.dci)} ${esc(l.strength)}</strong> (${esc(l.form)}) — ${l.dose} × ${l.perDay} /jour pendant ${l.days} jours, ${ROUTE[l.route]?.fr ?? l.route} — quantité : ${l.quantity}</li>`,
    )
    .join("");
  const ar = lines
    .map(
      (l) =>
        `<li><strong dir="ltr">${esc(l.dci)} ${esc(l.strength)}</strong> — ${l.dose} × ${l.perDay} يوميا لمدة ${l.days} أيام، ${ROUTE[l.route]?.ar ?? l.route} — الكمية : ${l.quantity}</li>`,
    )
    .join("");
  const date = p.signedAt.slice(0, 10);
  const name = p.patient?.name ?? "—";
  const id = p.patient?.identifier ?? "—";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ordonnance ${esc(p.number)}</title></head><body>
<table width="100%"><tr>
<td valign="top" width="50%"><h2>CHU Djibouti — Ordonnance ${esc(p.number)}</h2>
<p>Date : ${esc(date)}<br>Patient : ${esc(name)} (${esc(id)})<br>Prescripteur : ${esc(p.prescriber.name ?? p.prescriber.id)}</p>
<ol>${fr}</ol>${p.supersedes ? "<p><em>Cette ordonnance remplace une version précédente.</em></p>" : ""}</td>
<td valign="top" width="50%" dir="rtl" lang="ar" style="text-align:right"><h2>مستشفى جيبوتي الجامعي — وصفة طبية ${esc(p.number)}</h2>
<p>التاريخ : ${esc(date)}<br>المريض : ${esc(name)} (${esc(id)})<br>الطبيب : ${esc(p.prescriber.name ?? p.prescriber.id)}</p>
<ol>${ar}</ol></td>
</tr></table>
<div style="display:flex;align-items:center;gap:12px"><div data-qr="prescription">${qrSvg(input.payload, 140)}</div><p>Code de vérification (la pharmacie le scanne) : <code>${esc(input.payload)}</code></p></div>
</body></html>`;
}
