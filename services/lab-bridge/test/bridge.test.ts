import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { createForwarder } from "../src/forward.ts";
import { sendAstm, sendHl7 } from "../src/simulator.ts";

// API simulée : répond selon un scénario ; garde chaque appel reçu.
let api: Server;
let apiUrl = "";
let calls: { url: string; auth: string | undefined; message: string }[] = [];
let script: { status: number; body?: unknown }[] = [];
let tokenCalls = 0;
before(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/token") {
        tokenCalls += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: `jeton-${tokenCalls}`, expires_in: 300 }));
        return;
      }
      calls.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        message: JSON.parse(raw).message,
      });
      const step = script.shift() ?? { status: 200, body: { accepted: [{}], rejected: [] } };
      res.statusCode = step.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(step.body ?? { accepted: [{}], rejected: [] }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => api.close());

const tokens = () => ({
  token: async (force?: boolean) => {
    const r = await fetch(`${apiUrl}/token`, { method: "POST" });
    const j = (await r.json()) as { access_token: string };
    return force ? `${j.access_token}-neuf` : j.access_token;
  },
});
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`délai dépassé : ${what}`);
};

async function withBridge(
  protocol: "astm" | "hl7",
  run: (port: number, f: ReturnType<typeof createForwarder>, dir: string) => Promise<void>,
) {
  calls = [];
  script = [];
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const forwarder = createForwarder({ spoolDir: dir, apiUrl, tokens: tokens(), retryMs: 80 });
  const server: Server = createBridge({
    analyzer: "SIM1",
    protocol,
    forwarder,
  }) as unknown as Server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run((server.address() as AddressInfo).port, forwarder, dir);
  } finally {
    server.close();
    forwarder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const RECORDS = [
  "H|\\^&|||Analyseur",
  "O|1|S-000123X||^^^GLU",
  "R|1|^^^GLU|5.2|mmol/L|||||F",
  "L|1|N",
];

test("ASTM de bout en bout : automate simulé → pont → API ; un NAK est rejoué sans doublon", async () => {
  await withBridge("astm", async (port, f) => {
    const { naks } = await sendAstm("127.0.0.1", port, RECORDS, { corruptFirstFrame: true });
    assert.equal(naks, 1);
    await until(() => f.pendingCount() === 0 && calls.length === 1, "livraison");
    assert.equal(calls.length, 1, "un seul envoi malgré la trame rejouée");
    assert.equal(calls[0]!.url, "/api/lab/analyzers/SIM1/messages");
    assert.equal(calls[0]!.message, "H|SIM1\nO|S-000123X\nR|GLU|5.2|mmol/L");
    assert.match(calls[0]!.auth ?? "", /^Bearer jeton-/);
  });
});

test("HL7 de bout en bout : accusé AA renvoyé à l'automate après mise en sécurité ; message illisible → AE", async () => {
  await withBridge("hl7", async (port, f) => {
    const oru = [
      "MSH|^~\\&|AN|LAB|CHU|CHU|20261103||ORU^R01|M1|P|2.5",
      "OBR|1||S-000123X",
      "OBX|1|NM|GLU||5.2|mmol/L|||||F",
    ].join("\n");
    const ack = await sendHl7("127.0.0.1", port, oru);
    assert.match(ack, /MSA\|AA\|M1/);
    await until(() => f.pendingCount() === 0 && calls.length === 1, "livraison");
    assert.equal(calls[0]!.message, "H|SIM1\nO|S-000123X\nR|GLU|5.2|mmol/L");
    const bad = await sendHl7("127.0.0.1", port, "MSH|^~\\&|AN|LAB|CHU|CHU|t||ADT^A01|M2|P|2.5");
    assert.match(bad, /MSA\|AE\|M2/);
  });
});

test("API en panne : rien n'est perdu, l'ordre est conservé, tout part au retour de l'API", async () => {
  await withBridge("astm", async (port, f) => {
    script = [{ status: 503 }, { status: 503 }, { status: 503 }];
    await sendAstm("127.0.0.1", port, RECORDS);
    await sendAstm(
      "127.0.0.1",
      port,
      RECORDS.map((r) => r.replace("S-000123X", "S-000124Y").replace("5.2", "7.7")),
    );
    await until(() => calls.length >= 3, "premières tentatives");
    assert.ok(f.pendingCount() >= 1, "encore en file pendant la panne");
    await until(() => f.pendingCount() === 0, "retour de l'API");
    const ok = calls.slice(-2).map((c) => c.message);
    assert.match(ok[0]!, /S-000123X/);
    assert.match(ok[1]!, /S-000124Y/);
  });
});

test("redémarrage du pont : les messages en file sont repris", async () => {
  calls = [];
  script = [{ status: 503 }];
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const a = createForwarder({ spoolDir: dir, apiUrl, tokens: tokens(), retryMs: 60_000 });
  a.submit({
    analyzer: "SIM1",
    specimenScan: "S-9",
    results: [{ code: "GLU", value: "5", unit: "" }],
    skipped: [],
  });
  await until(() => calls.length === 1, "premier essai");
  a.stop();
  assert.equal(a.pendingCount(), 1, "toujours sur disque");
  const b = createForwarder({ spoolDir: dir, apiUrl, tokens: tokens() });
  await b.flush();
  assert.equal(b.pendingCount(), 0);
  assert.equal(calls.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("refus définitif de l'API (échantillon inconnu) : mis de côté, remis en file sur demande ; résultats refusés signalés", async () => {
  await withBridge("astm", async (port, f, dir) => {
    script = [{ status: 404, body: { error: { code: "unknown_specimen" } } }];
    await sendAstm("127.0.0.1", port, RECORDS);
    await until(() => f.rejectedCount() === 1, "mise de côté");
    assert.equal(f.pendingCount(), 0);
    assert.ok(readdirSync(join(dir, "rejected")).some((x) => x.endsWith(".reason")));
    script = [
      {
        status: 200,
        body: { accepted: [], rejected: [{ code: "GLU", reason: "échantillon non reçu" }] },
      },
    ];
    assert.equal(f.requeueRejected(), 1);
    await until(
      () => readdirSync(join(dir, "rejected")).some((x) => x.startsWith("partial-")),
      "résultat refusé signalé",
    );
    assert.equal(f.rejectedCount(), 0);
  });
});

test("jeton expiré (401) : un nouveau jeton, un seul nouvel essai", async () => {
  await withBridge("astm", async (port, f) => {
    script = [{ status: 401 }];
    await sendAstm("127.0.0.1", port, RECORDS);
    await until(() => f.pendingCount() === 0 && calls.length === 2, "second essai");
    assert.match(calls[1]!.auth ?? "", /-neuf$/);
  });
});
