import { createServer, type Server, type Socket } from "node:net";
import { astmReceiver, astmToInternal } from "./astm.ts";
import type { createForwarder } from "./forward.ts";
import { hl7Ack, mllpReceiver, mllpWrap, oruToInternal } from "./hl7.ts";

export type Protocol = "astm" | "hl7";
type Forwarder = ReturnType<typeof createForwarder>;

export interface BridgeOptions {
  analyzer: string;
  protocol: Protocol;
  forwarder: Forwarder;
  log?: (event: Record<string, unknown>) => void;
  verifyChecksum?: boolean;
}

/** Serveur TCP : l'automate s'y connecte (mode le plus courant : l'automate est le client, le pont l'hôte). */
export function createBridge(o: BridgeOptions): Server {
  const log = o.log ?? (() => {});
  return createServer((socket: Socket) => {
    socket.setTimeout(120_000, () => socket.destroy());
    socket.on("error", (e) => log({ event: "socket_error", error: String(e) }));
    if (o.protocol === "astm") {
      const rx = astmReceiver(
        o.verifyChecksum === undefined ? {} : { verifyChecksum: o.verifyChecksum },
      );
      socket.on("data", (chunk: Buffer) => {
        const { replies, messages } = rx.push(chunk);
        // Le message est mis en sécurité sur disque avant d'envoyer le dernier ACK de la poignée de main.
        for (const m of messages)
          for (const internal of astmToInternal(m, o.analyzer)) o.forwarder.submit(internal);
        for (const r of replies) socket.write(r);
      });
    } else {
      const rx = mllpReceiver();
      socket.on("data", (chunk: Buffer) => {
        for (const text of rx.push(chunk)) {
          try {
            for (const internal of oruToInternal(text, o.analyzer)) o.forwarder.submit(internal);
            socket.write(mllpWrap(hl7Ack(text, "AA")));
          } catch (error) {
            log({ event: "hl7_unreadable", error: String(error) });
            socket.write(
              mllpWrap(hl7Ack(text, "AE", String(error instanceof Error ? error.message : error))),
            );
          }
        }
      });
    }
  });
}
