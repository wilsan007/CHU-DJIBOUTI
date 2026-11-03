import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, test } from "node:test";
import { httpSmsProvider, maskPhone, normalizePhone, providerFromEnv } from "../src/common/sms.ts";

test("numéros de Djibouti : formats usuels ramenés à +253XXXXXXXX, le reste refusé", () => {
  for (const ok of [
    "77 12 34 56",
    "77123456",
    "0025377123456",
    "+253 77 12 34 56",
    "00253-77-12-34-56",
  ])
    assert.equal(normalizePhone(ok), "+25377123456", ok);
  for (const bad of ["1234", "abc", "+33612345678", "7712345", "771234567", ""])
    assert.throws(() => normalizePhone(bad), /invalide/, bad);
  assert.equal(maskPhone("+25377123456"), "+2537****56");
});

let server: Server;
let url = "";
let calls: { headers: IncomingMessage["headers"]; body: Record<string, string> }[] = [];
let script: number[] = [];
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ headers: req.headers, body: JSON.parse(raw) });
      const status = script.shift() ?? 200;
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/sms`;
});
after(() => server.close());
const reset = (...codes: number[]) => {
  calls = [];
  script = codes;
};

test("envoi : numéro normalisé, jeton transmis, champs configurables", async () => {
  reset();
  const p = httpSmsProvider({
    url,
    authorization: "Bearer jeton-de-test",
    sender: "CHU",
    fields: { to: "msisdn", text: "message", sender: "from" },
  });
  await p.send({ to: "77 12 34 56", text: "Bonjour" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body, { msisdn: "+25377123456", message: "Bonjour", from: "CHU" });
  assert.equal(calls[0]!.headers.authorization, "Bearer jeton-de-test");
});

test("erreur 5xx : réessayée puis acceptée ; erreur 4xx : jamais réessayée", async () => {
  reset(503, 502, 200);
  await httpSmsProvider({ url, backoffMs: 1 }).send({ to: "77123456", text: "x" });
  assert.equal(calls.length, 3);
  reset(400);
  await assert.rejects(
    httpSmsProvider({ url, backoffMs: 1 }).send({ to: "77123456", text: "x" }),
    /répondu 400/,
  );
  assert.equal(calls.length, 1);
  reset(500, 500, 500, 500);
  await assert.rejects(
    httpSmsProvider({ url, backoffMs: 1, retries: 2 }).send({ to: "77123456", text: "x" }),
    /répondu 500/,
  );
  assert.equal(calls.length, 3, "un essai + deux reprises");
});

test("l'erreur ne contient jamais le numéro complet ; passerelle injoignable = échec propre", async () => {
  await assert.rejects(
    httpSmsProvider({ url: "http://127.0.0.1:1/sms", retries: 0, timeoutMs: 500 }).send({
      to: "77123456",
      text: "x",
    }),
    (e: Error) => !e.message.includes("77123456") && e.message.includes("+2537****56"),
  );
  await assert.rejects(httpSmsProvider({ url }).send({ to: "abc", text: "x" }), /invalide/);
});

test("sans configuration : journal seulement, aucun envoi", async () => {
  reset();
  const seen: string[] = [];
  await providerFromEnv({}, (m) => seen.push(m)).send({ to: "77123456", text: "Rappel" });
  assert.equal(calls.length, 0);
  assert.match(seen[0]!, /aucune passerelle/);
  const p = providerFromEnv(
    { SMS_GATEWAY_URL: url, SMS_FIELD_TO: "n", SMS_FIELD_TEXT: "t" },
    () => {},
  );
  await p.send({ to: "77123456", text: "Rappel" });
  assert.deepEqual(calls[0]!.body, { n: "+25377123456", t: "Rappel" });
});
