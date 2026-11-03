import { randomUUID } from "node:crypto";

/**
 * Codage DICOM minimal (Part 10, « Explicit VR Little Endian ») : juste ce qu'il faut pour écrire une liste de travail
 * (Modality Worklist) lue par Orthanc et, pour les tests, une petite image. Aucune bibliothèque externe.
 */
export type Vr = "AE" | "CS" | "DA" | "LO" | "PN" | "SH" | "TM" | "UI" | "US" | "OB" | "SQ";
export interface Element {
  tag: [number, number];
  vr: Vr;
  value: string | number | Buffer | Element[][];
}

const LONG_VR = new Set<Vr>(["OB", "SQ"]);
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

function valueBytes(e: Element): Buffer {
  if (e.vr === "SQ") {
    return Buffer.concat(
      (e.value as Element[][]).map((item) => {
        const body = encodeDataset(item);
        return Buffer.concat([u16(0xfffe), u16(0xe000), u32(body.length), body]);
      }),
    );
  }
  if (e.vr === "US") return u16(Number(e.value));
  if (e.vr === "OB") {
    const b = e.value as Buffer;
    return b.length % 2 ? Buffer.concat([b, Buffer.from([0])]) : b;
  }
  const b = Buffer.from(String(e.value), "utf8");
  if (b.length % 2 === 0) return b;
  return Buffer.concat([b, Buffer.from([e.vr === "UI" ? 0 : 0x20])]);
}

export function encodeDataset(elements: Element[]): Buffer {
  const sorted = [...elements].sort((a, b) => a.tag[0] - b.tag[0] || a.tag[1] - b.tag[1]);
  return Buffer.concat(
    sorted.map((e) => {
      const v = valueBytes(e);
      const head = Buffer.concat([u16(e.tag[0]), u16(e.tag[1]), Buffer.from(e.vr, "ascii")]);
      return LONG_VR.has(e.vr)
        ? Buffer.concat([head, u16(0), u32(v.length), v])
        : Buffer.concat([head, u16(v.length), v]);
    }),
  );
}

/** UID de la racine « 2.25 » (UUID converti en entier décimal) : unique sans attribution de racine. */
export function newUid(): string {
  return `2.25.${BigInt(`0x${randomUUID().replace(/-/g, "")}`).toString()}`;
}

const TRANSFER_SYNTAX = "1.2.840.10008.1.2.1";
const IMPLEMENTATION_UID = "2.25.4242424242424242424242424242424242";

export function encodePart10(sopClass: string, sopInstance: string, dataset: Element[]): Buffer {
  const meta = encodeDataset([
    { tag: [2, 1], vr: "OB", value: Buffer.from([0, 1]) },
    { tag: [2, 2], vr: "UI", value: sopClass },
    { tag: [2, 3], vr: "UI", value: sopInstance },
    { tag: [2, 0x10], vr: "UI", value: TRANSFER_SYNTAX },
    { tag: [2, 0x12], vr: "UI", value: IMPLEMENTATION_UID },
  ]);
  // (0002,0000) : longueur du groupe, de VR UL.
  const ul = Buffer.concat([u16(2), u16(0), Buffer.from("UL"), u16(4), u32(meta.length)]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), ul, meta, encodeDataset(dataset)]);
}

export interface WorklistItem {
  accession: string;
  familyName: string | null;
  givenName: string | null;
  patientId: string;
  birthDate: string | null; // AAAA-MM-JJ
  sex: "male" | "female" | null;
  modality: string;
  procedure: string;
  /** Jour et heure locaux prévus (AAAA-MM-JJ, HH:MM). */
  scheduledDate: string;
  scheduledTime: string;
  stationAet: string;
}

const compactDate = (d: string): string => d.replace(/-/g, "");
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const dicomName = (s: string | null): string => (s ?? "").replace(/[\\^=]/g, " ").trim();

/** Liste de travail pour un appareil : l'accession et le patient arrivent dans les images sans ressaisie. */
export function buildWorklistFile(item: WorklistItem): Buffer {
  const studyUid = newUid();
  return encodePart10("1.2.840.10008.5.1.4.31", newUid(), [
    { tag: [0x8, 0x5], vr: "CS", value: "ISO_IR 192" },
    { tag: [0x8, 0x50], vr: "SH", value: clip(item.accession, 16) },
    {
      tag: [0x10, 0x10],
      vr: "PN",
      value: clip(`${dicomName(item.familyName)}^${dicomName(item.givenName)}`, 64),
    },
    { tag: [0x10, 0x20], vr: "LO", value: clip(item.patientId, 64) },
    { tag: [0x10, 0x30], vr: "DA", value: item.birthDate ? compactDate(item.birthDate) : "" },
    {
      tag: [0x10, 0x40],
      vr: "CS",
      value: item.sex === "male" ? "M" : item.sex === "female" ? "F" : "O",
    },
    { tag: [0x20, 0xd], vr: "UI", value: studyUid },
    { tag: [0x32, 0x1060], vr: "LO", value: clip(item.procedure, 64) },
    { tag: [0x40, 0x1001], vr: "SH", value: clip(item.accession, 16) },
    {
      tag: [0x40, 0x100],
      vr: "SQ",
      value: [
        [
          { tag: [0x8, 0x60], vr: "CS", value: item.modality },
          { tag: [0x40, 0x1], vr: "AE", value: clip(item.stationAet, 16) },
          { tag: [0x40, 0x2], vr: "DA", value: compactDate(item.scheduledDate) },
          { tag: [0x40, 0x3], vr: "TM", value: item.scheduledTime.replace(":", "") + "00" },
          { tag: [0x40, 0x7], vr: "LO", value: clip(item.procedure, 64) },
          { tag: [0x40, 0x9], vr: "SH", value: clip(item.accession, 16) },
        ],
      ],
    },
  ]);
}

/** Petite image radiographique de test (8 bits, niveaux de gris) : pour les essais, jamais pour un vrai patient. */
export function buildTestImage(o: {
  patientId: string;
  patientName: string;
  accession: string;
  modality?: string;
  size?: number;
}): Buffer {
  const n = o.size ?? 32;
  const pixels = Buffer.alloc(n * n);
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) pixels[y * n + x] = (x * 255) / (n - 1);
  const sopInstance = newUid();
  const sopClass = "1.2.840.10008.5.1.4.1.1.1"; // Computed Radiography Image Storage
  return encodePart10(sopClass, sopInstance, [
    { tag: [0x8, 0x16], vr: "UI", value: sopClass },
    { tag: [0x8, 0x18], vr: "UI", value: sopInstance },
    { tag: [0x8, 0x50], vr: "SH", value: o.accession },
    { tag: [0x8, 0x60], vr: "CS", value: o.modality ?? "CR" },
    { tag: [0x10, 0x10], vr: "PN", value: o.patientName },
    { tag: [0x10, 0x20], vr: "LO", value: o.patientId },
    { tag: [0x20, 0xd], vr: "UI", value: newUid() },
    { tag: [0x20, 0xe], vr: "UI", value: newUid() },
    { tag: [0x20, 0x10], vr: "SH", value: "1" },
    { tag: [0x20, 0x11], vr: "SH", value: "1" },
    { tag: [0x20, 0x13], vr: "SH", value: "1" },
    { tag: [0x28, 0x2], vr: "US", value: 1 },
    { tag: [0x28, 0x4], vr: "CS", value: "MONOCHROME2" },
    { tag: [0x28, 0x10], vr: "US", value: n },
    { tag: [0x28, 0x11], vr: "US", value: n },
    { tag: [0x28, 0x100], vr: "US", value: 8 },
    { tag: [0x28, 0x101], vr: "US", value: 8 },
    { tag: [0x28, 0x102], vr: "US", value: 7 },
    { tag: [0x28, 0x103], vr: "US", value: 0 },
    { tag: [0x7fe0, 0x10], vr: "OB", value: pixels },
  ]);
}
