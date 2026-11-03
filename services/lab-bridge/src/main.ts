import { createBridge, type Protocol } from "./bridge.ts";
import { clientCredentials, createForwarder } from "./forward.ts";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} est obligatoire`);
  return v;
};
const log = (e: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
};

const forwarder = createForwarder({
  spoolDir: process.env.BRIDGE_SPOOL_DIR ?? "./spool",
  apiUrl: need("BRIDGE_API_URL"),
  tokens: clientCredentials({
    tokenUrl: need("BRIDGE_TOKEN_URL"),
    clientId: process.env.BRIDGE_CLIENT_ID ?? "chu-lab-bridge",
    clientSecret: need("BRIDGE_CLIENT_SECRET"),
  }),
  log,
});

if (process.argv.includes("--requeue")) {
  log({ event: "requeued", count: forwarder.requeueRejected() });
  await forwarder.flush();
  process.exit(0);
}

const protocol = (process.env.BRIDGE_PROTOCOL ?? "astm") as Protocol;
if (protocol !== "astm" && protocol !== "hl7") throw new Error("BRIDGE_PROTOCOL : astm ou hl7");
const port = Number(process.env.BRIDGE_PORT ?? 4010);
const server = createBridge({
  analyzer: need("BRIDGE_ANALYZER"),
  protocol,
  forwarder,
  log,
  verifyChecksum: process.env.BRIDGE_ASTM_CHECKSUM !== "off",
});
server.listen(port, process.env.BRIDGE_HOST ?? "0.0.0.0", () =>
  log({ event: "listening", port, protocol }),
);
void forwarder.flush(); // messages restés en file depuis le dernier arrêt
process.on("SIGTERM", () => {
  server.close();
  forwarder.stop();
});
