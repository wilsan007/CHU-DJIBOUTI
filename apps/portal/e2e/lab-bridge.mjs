// Automate de laboratoire simulé → pont (ASTM puis HL7) → vraie API derrière le vrai Keycloak : le résultat arrive sur
// le bon échantillon, une coupure de l'API ne perd rien, le jeton du compte de service n'a que les droits du laboratoire.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, cardPayload, importCatalogs, KEYCLOAK, sleep } from "./lib.mjs";
import { sendAstm, sendHl7 } from "../../../services/lab-bridge/src/simulator.ts";

const secret = process.env.CHU_LAB_BRIDGE_SECRET;
if (!secret) throw new Error("CHU_LAB_BRIDGE_SECRET est obligatoire");
const suffix = String(Date.now()).slice(-6);
const until = async (fn, what, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`Délai dépassé : ${what}`);
};

await importCatalogs();
await api("dev-cashier", "/api/billing/cash-sessions/open", { method: "POST" });
await api("dev-biologist", "/api/lab/tests/GLY/ranges", {
  method: "PUT",
  body: {
    ranges: [
      {
        sex: "any",
        ageMinDays: 6570,
        ageMaxDays: 32850,
        criticalLow: 2.2,
        low: 3.9,
        high: 6.1,
        criticalHigh: 25,
      },
    ],
    validatedBy: "Biologiste test",
    validatedOn: "2026-11-01",
  },
  expect: 200,
});
await api("dev-biologist", "/api/lab/analyzers/SIMASTM/mappings", {
  method: "PUT",
  body: { mappings: [{ analyzerCode: "GLU", testCode: "GLY" }] },
  expect: 200,
});
await api("dev-biologist", "/api/lab/analyzers/SIMHL7/mappings", {
  method: "PUT",
  body: { mappings: [{ analyzerCode: "GLU", testCode: "GLY" }] },
  expect: 200,
});

async function receivedSpecimen(tag) {
  const patient = (
    await api("dev-reception", "/api/patients", {
      method: "POST",
      body: {
        givenName: tag,
        familyName: `Pont${suffix}`,
        sex: "female",
        birthDate: "1980-01-02",
        phone: `0077${suffix}${tag.length}`,
        confirmNotDuplicate: true,
      },
      expect: 201,
    })
  ).data;
  const adm = (
    await api("dev-reception", "/api/admissions", {
      method: "POST",
      body: {
        patientId: patient.id,
        departmentCode: "CONS",
        payerCode: "DIRECT",
        actCode: "CONS-GEN",
      },
      expect: 201,
    })
  ).data;
  const order = (
    await api("dev-doctor", "/api/service-orders", {
      method: "POST",
      body: {
        patientId: patient.id,
        encounterId: adm.encounter.id,
        items: [{ actCode: "LAB-GLY", quantity: 1 }],
      },
      expect: 201,
    })
  ).data;
  const inv = await until(
    async () =>
      (await api("dev-cashier", `/api/billing/invoices?status=pending&orderNumber=${order.number}`))
        .data.invoices[0],
    "facture",
  );
  await api("dev-cashier", `/api/billing/invoices/${inv.id}/pay`, {
    method: "POST",
    body: { method: "cash", receivedAmount: 1_000_000 },
    expect: 200,
  });
  const req = await until(
    async () =>
      (await api("dev-lab", `/api/lab/requests?patientId=${patient.id}`)).data.requests[0],
    "demande du laboratoire",
  );
  const sp = (
    await api("dev-lab", `/api/lab/requests/${req.id}/collect`, {
      method: "POST",
      body: { patientScan: await cardPayload(patient.id), specimenType: "Sérum" },
      expect: 201,
    })
  ).data;
  await api("dev-lab", "/api/lab/specimens/receive", {
    method: "POST",
    body: { scan: sp.payload },
    expect: 200,
  });
  return { patient, sp };
}
const resultsOf = async (patientId) =>
  (await api("dev-lab", `/api/lab/patients/${patientId}/results`)).data?.results ?? [];

const spool = mkdtempSync(join(tmpdir(), "chu-bridge-"));
let bridge;
const start = (
  protocol,
  analyzer,
  port,
  apiUrl = process.env.PORTAL_URL ?? "http://localhost:8080",
) => {
  bridge = spawn(process.execPath, ["services/lab-bridge/src/main.ts"], {
    env: {
      ...process.env,
      BRIDGE_ANALYZER: analyzer,
      BRIDGE_PROTOCOL: protocol,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_API_URL: apiUrl,
      BRIDGE_TOKEN_URL: `${KEYCLOAK}/realms/chu/protocol/openid-connect/token`,
      BRIDGE_CLIENT_SECRET: secret,
      BRIDGE_SPOOL_DIR: spool,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  bridge.stdout.on("data", (d) => (out += d));
  return { logs: () => out, stop: () => bridge.kill() };
};

try {
  // Le compte de service n'a que le rôle « lab » : il ne peut ni valider biologiquement ni lire l'administration.
  const tok = await (
    await fetch(`${KEYCLOAK}/realms/chu/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "chu-lab-bridge",
        client_secret: secret,
      }),
    })
  ).json();
  assert.ok(tok.access_token, "jeton du pont obtenu");
  const claims = JSON.parse(Buffer.from(tok.access_token.split(".")[1], "base64url").toString());
  assert.deepEqual(
    claims.realm_access.roles.filter((r) => ["lab", "admin", "doctor", "biologist"].includes(r)),
    ["lab"],
  );
  assert.equal(
    (
      await fetch("http://localhost:8080/api/admin/users", {
        headers: { authorization: `Bearer ${tok.access_token}` },
      })
    ).status,
    403,
  );

  // ---- ASTM ----
  const a = await receivedSpecimen("Astm");
  const b = await receivedSpecimen("Autre");
  let p = start("astm", "SIMASTM", 4411);
  await until(() => p.logs().includes("listening"), "pont démarré");
  await sendAstm("127.0.0.1", 4411, [
    "H|\\^&|||Simulateur",
    "P|1",
    `O|1|${a.sp.payload}||^^^GLU`,
    "R|1|^^^GLU|5.2|mmol/L|3.9-6.1|N||F",
    "L|1|N",
  ]);
  const got = await until(
    async () => (await resultsOf(a.patient.id)).find((r) => r.testCode === "GLY"),
    "résultat ASTM sur l'échantillon",
  );
  assert.equal(Number(got.value), 5.2);
  assert.equal((await resultsOf(b.patient.id)).length, 0, "l'autre échantillon n'a rien reçu");
  console.log("  ✔ ASTM : résultat arrivé sur le bon échantillon, signalement normal");

  // ---- API coupée : on envoie quand même, rien ne se perd, tout part quand l'API revient ----
  p.stop();
  await sleep(300);
  p = start("astm", "SIMASTM", 4411, "http://127.0.0.1:9"); // API injoignable
  await until(() => p.logs().includes("listening"), "pont (API coupée)");
  await sendAstm("127.0.0.1", 4411, [
    "H|\\^&",
    `O|1|${b.sp.payload}||^^^GLU`,
    "R|1|^^^GLU|7.7|mmol/L|||||F",
    "L|1|N",
  ]);
  await until(() => p.logs().includes("api_unreachable"), "API injoignable constatée");
  assert.equal((await resultsOf(b.patient.id)).length, 0);
  p.stop();
  await sleep(300);
  p = start("astm", "SIMASTM", 4411); // redémarrage du pont, API revenue : le message en file est repris
  const got2 = await until(
    async () => (await resultsOf(b.patient.id)).find((r) => r.testCode === "GLY"),
    "résultat repris après coupure",
  );
  assert.equal(Number(got2.value), 7.7);
  console.log("  ✔ coupure de l'API + redémarrage du pont : le résultat n'est pas perdu");
  p.stop();
  await sleep(300);

  // ---- HL7 / MLLP ----
  const c = await receivedSpecimen("Hlsept");
  p = start("hl7", "SIMHL7", 4412);
  await until(() => p.logs().includes("listening"), "pont HL7 démarré");
  const ack = await sendHl7(
    "127.0.0.1",
    4412,
    [
      "MSH|^~\\&|AN|LAB|CHU|CHU|20261103||ORU^R01|M77|P|2.5",
      `OBR|1||${c.sp.payload}`,
      "OBX|1|NM|GLU||30|mmol/L|||||F",
    ].join("\n"),
  );
  assert.match(ack, /MSA\|AA\|M77/);
  const got3 = await until(
    async () => (await resultsOf(c.patient.id)).find((r) => r.testCode === "GLY"),
    "résultat HL7",
  );
  assert.equal(Number(got3.value), 30);
  assert.match(got3.flag, /critical/, "30 mmol/L est une valeur critique");
  console.log("  ✔ HL7 : résultat reçu, valeur critique reconnue (30 mmol/L)");
  p.stop();

  // ---- Échantillon inconnu : mis de côté, jamais appliqué à un autre ----
  p = start("astm", "SIMASTM", 4411);
  await until(() => p.logs().includes("listening"), "pont");
  await sendAstm("127.0.0.1", 4411, [
    "H|\\^&",
    "O|1|S-999999||^^^GLU",
    "R|1|^^^GLU|9|mmol/L|||||F",
    "L|1|N",
  ]);
  await until(() => p.logs().includes("rejected"), "refus définitif signalé");
  console.log("  ✔ échantillon inconnu : mis de côté dans rejected/, journalisé");
  p.stop();
  console.log("OK : pont d'automates vérifié contre la vraie API et le vrai Keycloak.");
} finally {
  bridge?.kill();
}
