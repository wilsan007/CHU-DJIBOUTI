/**
 * ASTM E1381 (poignée de main et trames) et E1394 (enregistrements) : le dialogue de la plupart des automates de
 * paillasse en série ou en TCP. Ce module ne fait que lire : il répond ACK/NAK trame par trame et rend les messages
 * complets. Il ne sait rien du CHU ; la traduction vers l'API est dans `toInternal`.
 */
export const ENQ = 0x05;
export const ACK = 0x06;
export const NAK = 0x15;
export const EOT = 0x04;
export const STX = 0x02;
export const ETX = 0x03;
export const ETB = 0x17;
const CR = 0x0d;
const LF = 0x0a;

export const checksum = (bytes: Uint8Array): string =>
  bytes
    .reduce((s, b) => (s + b) & 0xff, 0)
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");

/** Une trame ASTM : STX, numéro (0-7), texte, ETX (dernière) ou ETB (suite), somme de contrôle, CR LF. */
export function buildFrame(frameNumber: number, text: string, last = true): Buffer {
  const body = Buffer.concat([
    Buffer.from(String(frameNumber % 8)),
    Buffer.from(text, "latin1"),
    Buffer.from([last ? ETX : ETB]),
  ]);
  return Buffer.concat([Buffer.from([STX]), body, Buffer.from(checksum(body) + "\r\n", "latin1")]);
}

export type AstmRecord = string[]; // champs séparés par « | »

export interface Receiver {
  /** Octets à renvoyer à l'automate (ACK/NAK) et messages complets décodés. */
  push(chunk: Buffer): { replies: Buffer[]; messages: AstmRecord[][] };
}

export function astmReceiver(options: { verifyChecksum?: boolean } = {}): Receiver {
  const verify = options.verifyChecksum ?? true;
  let buf = Buffer.alloc(0);
  let receiving = false;
  let expected = 1;
  let lastAccepted = -1;
  let pendingText = "";
  let records: AstmRecord[] = [];

  const flushMessage = (out: AstmRecord[][]): void => {
    if (records.length) out.push(records);
    records = [];
    pendingText = "";
  };

  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const replies: Buffer[] = [];
      const messages: AstmRecord[][] = [];
      for (;;) {
        if (buf.length === 0) break;
        const b = buf[0]!;
        if (b === ENQ) {
          receiving = true;
          expected = 1;
          lastAccepted = -1;
          pendingText = "";
          records = [];
          replies.push(Buffer.from([ACK]));
          buf = buf.subarray(1);
        } else if (b === EOT) {
          receiving = false;
          flushMessage(messages);
          buf = buf.subarray(1);
        } else if (b === STX && receiving) {
          // Trame complète : jusqu'à ETX/ETB, deux caractères de contrôle, CR, LF.
          let end = -1;
          for (let i = 1; i < buf.length; i += 1) {
            if (buf[i] === ETX || buf[i] === ETB) {
              end = i;
              break;
            }
          }
          if (end === -1 || buf.length < end + 5) break; // incomplète : on attend la suite
          const body = buf.subarray(1, end + 1);
          const given = buf
            .subarray(end + 1, end + 3)
            .toString("latin1")
            .toUpperCase();
          const terminated = buf[end + 3] === CR && buf[end + 4] === LF;
          buf = buf.subarray(end + 5);
          const fn = body[0]! - 0x30;
          const good = terminated && fn >= 0 && fn <= 7 && (!verify || given === checksum(body));
          if (!good) {
            replies.push(Buffer.from([NAK]));
            continue;
          }
          if (fn === lastAccepted) {
            // Retransmission d'une trame déjà reçue (notre ACK s'est perdu) : on acquitte sans l'ajouter deux fois.
            replies.push(Buffer.from([ACK]));
            continue;
          }
          if (fn !== expected % 8) {
            replies.push(Buffer.from([NAK]));
            continue;
          }
          lastAccepted = fn;
          expected += 1;
          pendingText += body.subarray(1, body.length - 1).toString("latin1");
          replies.push(Buffer.from([ACK]));
          if (body[body.length - 1] === ETX) {
            for (const line of pendingText.split("\r").filter((l) => l.trim() !== "")) {
              records.push(line.split("|"));
              if (line.startsWith("L|")) flushMessage(messages);
            }
            pendingText = "";
          }
        } else {
          buf = buf.subarray(1); // octet parasite hors trame : ignoré
        }
      }
      return { replies, messages };
    },
  };
}

/** Message neutre transmis à l'API (voir `parseAnalyzerMessage` dans le noyau). */
export interface InternalMessage {
  analyzer: string;
  specimenScan: string;
  results: { code: string; value: string; unit: string }[];
  skipped: string[];
}
export const toText = (m: InternalMessage): string =>
  [
    `H|${m.analyzer}`,
    `O|${m.specimenScan}`,
    ...m.results.map((r) => `R|${r.code}|${r.value}|${r.unit}`),
  ].join("\n");

const testCode = (universalId: string): string => {
  const parts = universalId.split("^");
  return (parts[3] || parts.find((p) => p !== "") || "").trim();
};

/** Un message ASTM peut contenir plusieurs échantillons (O) : un message neutre par échantillon. */
export function astmToInternal(message: AstmRecord[], analyzer: string): InternalMessage[] {
  const out: InternalMessage[] = [];
  let current: InternalMessage | undefined;
  for (const r of message) {
    const type = r[0]?.trim();
    if (type === "O") {
      const scan = ((r[2] || r[3]) ?? "").split("^")[0]!.trim();
      current = { analyzer, specimenScan: scan, results: [], skipped: [] };
      out.push(current);
    } else if (type === "R" && current) {
      const code = testCode(r[2] ?? "");
      const status = (r[8] ?? "F").trim().toUpperCase() || "F";
      // F final, C corrigé : acceptés. P préliminaire, X impossible, I en cours : jamais enregistrés.
      if (status !== "F" && status !== "C") {
        current.skipped.push(`${code} (statut ${status})`);
        continue;
      }
      current.results.push({
        code,
        value: (r[3] ?? "").trim(),
        unit: (r[4] ?? "").split("^")[0]!.trim(),
      });
    }
  }
  return out;
}
