import { connect } from "node:net";
import { ACK, buildFrame, ENQ, EOT, NAK } from "./astm.ts";
import { mllpReceiver, mllpWrap } from "./hl7.ts";

/** Simulateur d'automate ASTM : poignée de main complète, nouvel envoi sur NAK, trames multiples possibles. */
export async function sendAstm(
  host: string,
  port: number,
  records: string[],
  options: { maxFrameChars?: number; corruptFirstFrame?: boolean } = {},
): Promise<{ naks: number }> {
  const socket = connect({ host, port });
  await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
  const next = (): Promise<number> =>
    new Promise((resolve) => socket.once("data", (d: Buffer) => resolve(d[0]!)));
  let naks = 0;
  socket.write(Buffer.from([ENQ]));
  if ((await next()) !== ACK) throw new Error("ENQ non acquitté");
  const text = records.join("\r") + "\r";
  const size = options.maxFrameChars ?? 240;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  let n = 1;
  let first = true;
  for (let c = 0; c < chunks.length; c += 1) {
    const frame = buildFrame(n, chunks[c]!, c === chunks.length - 1);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const toSend = Buffer.from(frame);
      if (first && options.corruptFirstFrame && attempt === 0)
        toSend[toSend.length - 4] = toSend[toSend.length - 4]! ^ 0x01; // somme de contrôle fausse
      socket.write(toSend);
      const reply = await next();
      if (reply === ACK) break;
      if (reply !== NAK) throw new Error("réponse inattendue");
      naks += 1;
      if (attempt === 5) throw new Error("trop de NAK");
    }
    first = false;
    n += 1;
  }
  socket.write(Buffer.from([EOT]));
  await new Promise((r) => setTimeout(r, 50));
  socket.end();
  return { naks };
}

export async function sendHl7(host: string, port: number, message: string): Promise<string> {
  const socket = connect({ host, port });
  await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
  const rx = mllpReceiver();
  const ack = new Promise<string>((resolve) =>
    socket.on("data", (d: Buffer) => {
      const m = rx.push(d);
      if (m[0] !== undefined) resolve(m[0]);
    }),
  );
  socket.write(mllpWrap(message.replace(/\n/g, "\r")));
  const text = await ack;
  socket.end();
  return text;
}
