import type { InternalMessage } from "./astm.ts";

/** HL7 v2 sur MLLP : 0x0B message 0x1C 0x0D. */
export const SB = 0x0b;
export const EB = 0x1c;
const CR = 0x0d;

export const mllpWrap = (text: string): Buffer =>
  Buffer.concat([Buffer.from([SB]), Buffer.from(text, "utf8"), Buffer.from([EB, CR])]);

export function mllpReceiver(): { push(chunk: Buffer): string[] } {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const out: string[] = [];
      for (;;) {
        const start = buf.indexOf(SB);
        if (start === -1) {
          buf = Buffer.alloc(0);
          break;
        }
        const end = buf.indexOf(EB, start + 1);
        if (end === -1 || buf.length < end + 2) {
          buf = buf.subarray(start);
          break;
        }
        out.push(buf.subarray(start + 1, end).toString("utf8"));
        buf = buf.subarray(end + 2);
      }
      return out;
    },
  };
}

const segments = (text: string): string[][] =>
  text
    .split(/\r\n|\r|\n/)
    .filter((s) => s.trim() !== "")
    .map((s) => s.split("|"));

export function controlId(text: string): string {
  const msh = segments(text).find((s) => s[0] === "MSH");
  return msh?.[9] ?? "";
}

/** Accusé de réception HL7 : AA accepté, AE erreur d'application (message illisible). */
export function hl7Ack(original: string, code: "AA" | "AE", note = ""): string {
  const msh = segments(original).find((s) => s[0] === "MSH");
  const now = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return (
    `MSH|^~\\&|CHU-LIS|CHU|${msh?.[2] ?? ""}|${msh?.[3] ?? ""}|${now}||ACK^R01|ACK${Date.now()}|P|2.5\r` +
    `MSA|${code}|${msh?.[9] ?? ""}${note ? `|${note.replace(/[|\r\n]/g, " ")}` : ""}\r`
  );
}

/**
 * ORU^R01 → un message neutre par groupe OBR. L'identifiant d'échantillon est lu dans SPM-2 s'il existe, sinon OBR-3
 * (numéro du laboratoire), sinon OBR-2. Les résultats OBX dont le statut n'est ni F (final) ni C (corrigé) sont écartés.
 */
export function oruToInternal(text: string, analyzer: string): InternalMessage[] {
  const segs = segments(text);
  const msh = segs.find((s) => s[0] === "MSH");
  if (!msh) throw new Error("segment MSH absent");
  const type = msh[8] ?? "";
  if (!type.startsWith("ORU")) throw new Error(`type de message non pris en charge : ${type}`);
  const out: InternalMessage[] = [];
  let current: InternalMessage | undefined;
  let spm = "";
  for (const s of segs) {
    if (s[0] === "SPM") spm = ((s[2] ?? "").split("^")[0] ?? "").split("&")[0] ?? "";
    if (s[0] === "OBR") {
      const scan = (spm || s[3] || s[2] || "").split("^")[0]!.split("&")[0]!.trim();
      current = { analyzer, specimenScan: scan, results: [], skipped: [] };
      out.push(current);
      spm = "";
    } else if (s[0] === "OBX" && current) {
      const code = (s[3] ?? "").split("^")[0]!.trim();
      const status = (s[11] ?? "F").trim().toUpperCase() || "F";
      if (status !== "F" && status !== "C") {
        current.skipped.push(`${code} (statut ${status})`);
        continue;
      }
      current.results.push({
        code,
        value: (s[5] ?? "").trim(),
        unit: (s[6] ?? "").split("^")[0]!.trim(),
      });
    }
  }
  if (out.length === 0) throw new Error("aucun groupe OBR");
  return out;
}
