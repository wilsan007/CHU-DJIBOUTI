import { esc } from "../../common/html.ts";
import { qrSvg } from "../../common/qr.ts";
import { cardPayload } from "./card.ts";
import type { Patient } from "./types.ts";

/**
 * Carte du patient, au format carte bancaire (85,6 × 54 mm). Le QR ne contient QUE l'identifiant et sa clé de contrôle :
 * aucune donnée personnelle ni médicale (perdue, la carte ne révèle rien). Le nom imprimé aide à reconnaître la carte.
 */
export function renderCardHtml(p: Patient): string {
  const name = [p.givenName, p.familyName].filter(Boolean).join(" ") || "—";
  const payload = cardPayload(p.identifier);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Carte ${esc(p.identifier)}</title>
<style>@page{size:85.6mm 54mm;margin:0}body{margin:0;font-family:sans-serif}
.card{width:85.6mm;height:54mm;box-sizing:border-box;padding:4mm;display:flex;gap:4mm;border:1px solid #0b6b53}
.id{flex:1;font-size:11px}.brand{font-weight:700;color:#0b6b53;font-size:12px}h1{font-size:14px;margin:3mm 0 1mm}
code{font-size:10px}</style></head><body>
<div class="card"><div class="id"><div class="brand">CHU de Djibouti · مستشفى جيبوتي الجامعي</div>
<h1>${esc(name)}</h1>N° ${esc(p.identifier)}<br>${esc(p.birthDate ?? "")}<br><code>${esc(payload)}</code></div>
<div data-qr="card">${qrSvg(payload, 110)}</div></div></body></html>`;
}
