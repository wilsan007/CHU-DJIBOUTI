import assert from "node:assert/strict";
import { test } from "node:test";
import * as jsqrPackage from "jsqr";
import { qrSvg } from "../src/common/qr.ts";
import { cardPayload } from "../src/modules/identity/card.ts";
import { renderCardHtml } from "../src/modules/identity/card-print.ts";
import { specimenPayload } from "../src/modules/lab/service.ts";
import { renderPrescription } from "../src/modules/prescriptions/print.ts";

type Decode = (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const jsQR = (jsqrPackage as unknown as { default: Decode }).default;

/** Rastérise le SVG (carrés unitaires d'un chemin « M x y h1v1h-1z ») et le décode avec un vrai lecteur de QR. */
function decodeSvg(svg: string): string | null {
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(box, "viewBox");
  const total = Number(box[1]);
  const scale = 6;
  const size = total * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const m of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const [x0, y0] = [Number(m[1]) * scale, Number(m[2]) * scale];
    for (let y = y0; y < y0 + scale; y += 1)
      for (let x = x0; x < x0 + scale; x += 1) {
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  }
  return jsQR(data, size, size)?.data ?? null;
}
const svgIn = (html: string, kind: string): string => {
  const m = new RegExp(`<div data-qr="${kind}">(<svg[\\s\\S]*?</svg>)</div>`).exec(html);
  assert.ok(m, `QR « ${kind} » dans la page`);
  return m[1] as string;
};

test("le QR se relit exactement : identifiants de carte, d'échantillon et textes de longueurs différentes", () => {
  const samples = [
    cardPayload("000123"),
    cardPayload("P-ABC-9"),
    specimenPayload("S-000045"),
    "x",
    "ORD1.O-000099.00." + "a".repeat(60),
    "Texte avec accents : é à ç, et des chiffres 0123456789 — ".repeat(3),
  ];
  for (const text of samples) assert.equal(decodeSvg(qrSvg(text)), text, text.slice(0, 30));
});

test("page de la carte : QR décodé = code de la carte, sans donnée personnelle dans le QR", () => {
  const html = renderCardHtml({
    id: "00000000-0000-0000-0000-000000000001",
    identifier: "000321",
    kind: "regular",
    status: "active",
    mergedInto: null,
    externalId: null,
    givenName: "Fatouma <b>",
    familyName: "Ahmed",
    sex: "female",
    birthDate: "1990-05-06",
    ageEstimated: false,
    phone: "77123456",
    note: "secret",
    createdAt: new Date().toISOString(),
  });
  const decoded = decodeSvg(svgIn(html, "card"));
  assert.equal(decoded, cardPayload("000321"));
  assert.ok(
    !/Fatouma|Ahmed|1990|77123456|secret/.test(decoded ?? ""),
    "le QR ne porte que l'identifiant",
  );
  assert.ok(html.includes("Fatouma &lt;b&gt;"), "nom échappé dans la page (pas de HTML injecté)");
});

test("page de l'ordonnance : QR décodé = code de vérification", () => {
  const payload = "RX1.O-000012.34";
  const html = renderPrescription({
    prescription: {
      number: "O-000012",
      signedAt: "2026-11-03T10:00:00.000Z",
      supersedes: null,
      patient: { name: "Essai <script>", identifier: "000321" },
      prescriber: { id: "dr", name: "Dr Essai" },
      lines: [],
    },
    payload,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  assert.equal(decodeSvg(svgIn(html, "prescription")), payload);
  assert.ok(!html.includes("<script>"), "nom du patient échappé");
});
