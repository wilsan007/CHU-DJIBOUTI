import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildTestImage, buildWorklistFile } from "../src/modules/imaging/dicom.ts";
import {
  modalityOf,
  syncStudies,
  syncWorklists,
  type PacsConfig,
} from "../src/modules/imaging/pacs.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  makeCaller,
  newPatient,
  openCash,
  type Caller,
} from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
let orthanc: Server;
let cfg: PacsConfig;
let dir: string;
const DR = "dr-pacs";
const CASHIER = "caissier-pacs";
const TECH = "tech-pacs";
const RAD = "radiologue-pacs";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

// Orthanc simulé : études connues par numéro d'accession ; vérifie le compte technique (Basic).
const studiesByAccession = new Map<
  string,
  { id: string; patientId: string; instances: string[] }[]
>();
let down = false;
before(async () => {
  orthanc = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown, type = "application/json") => {
        res.statusCode = status;
        res.setHeader("content-type", type);
        res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
      };
      if (down) return send(503, {});
      if (req.headers.authorization !== `Basic ${Buffer.from("chu:secret").toString("base64")}`)
        return send(401, {});
      const url = req.url ?? "";
      if (url === "/tools/find") {
        const acc = JSON.parse(raw).Query.AccessionNumber as string;
        return send(
          200,
          (studiesByAccession.get(acc) ?? []).map((s) => ({
            ID: s.id,
            MainDicomTags: {
              AccessionNumber: acc,
              StudyInstanceUID: `uid-${s.id}`,
              StudyDescription: "Radiographie",
            },
            PatientMainDicomTags: { PatientID: s.patientId },
          })),
        );
      }
      const all = [...studiesByAccession.values()].flat();
      let m = /^\/studies\/([^/]+)\/statistics$/.exec(url);
      if (m)
        return send(200, {
          CountInstances: all.find((s) => s.id === m![1])?.instances.length ?? 0,
          CountSeries: 1,
        });
      m = /^\/studies\/([^/]+)\/series\?expand$/.exec(url);
      if (m) return send(200, [{ MainDicomTags: { Modality: "CR" } }]);
      m = /^\/studies\/([^/]+)\/instances$/.exec(url);
      if (m)
        return send(
          200,
          (all.find((s) => s.id === m![1])?.instances ?? []).map((id) => ({ ID: id })),
        );
      m = /^\/instances\/([^/]+)\/preview$/.exec(url);
      if (m) return send(200, PNG, "image/png");
      send(404, {});
    });
  });
  await new Promise<void>((r) => orthanc.listen(0, "127.0.0.1", r));
  dir = mkdtempSync(join(tmpdir(), "wl-"));
  cfg = {
    url: `http://127.0.0.1:${(orthanc.address() as AddressInfo).port}`,
    user: "chu",
    password: "secret",
    worklistDir: dir,
    stationAet: "RADIO1",
  };
  db = await createTestDatabase();
  t = await createTestApp(db.app, { pacs: cfg });
  call = makeCaller(t);
  await importCatalogs(call);
  await openCash(call, CASHIER);
});
after(async () => {
  await t.close();
  await db.drop();
  orthanc.close();
  rmSync(dir, { recursive: true, force: true });
});

async function released() {
  const patient = await newPatient(call, "Pacs");
  const adm = await admitPatient(call, patient.id);
  const order = await call(
    "doctor",
    "POST",
    "/api/service-orders",
    {
      patientId: patient.id,
      encounterId: adm.encounter.id,
      items: [{ actCode: "IMG-RX", quantity: 1 }],
    },
    DR,
  );
  assert.equal(order.status, 201, order.raw);
  await t.dispatcher.drain();
  const inv = await call(
    "cashier",
    "GET",
    `/api/billing/invoices?status=pending&orderNumber=${order.body.number}`,
    undefined,
    CASHIER,
  );
  await call(
    "cashier",
    "POST",
    `/api/billing/invoices/${inv.body.invoices[0].id}/pay`,
    { method: "cash", receivedAmount: 100000 },
    CASHIER,
  );
  await t.dispatcher.drain();
  const list = await call(
    "imaging",
    "GET",
    `/api/imaging/requests?patientId=${patient.id}`,
    undefined,
    TECH,
  );
  return {
    patient,
    request: list.body.requests[0] as { id: string; accession: string; status: string },
  };
}

test("modalité déduite du code de l'acte", () => {
  assert.equal(modalityOf("IMG-RX"), "CR");
  assert.equal(modalityOf("IMG-ECHO-ABD"), "US");
  assert.equal(modalityOf("SCAN-CRANE"), "CT");
  assert.equal(modalityOf("IRM-GENOU"), "MR");
  assert.equal(modalityOf("AUTRE"), "OT");
});

test("l'accession existe dès la création de l'examen ; la liste de travail est écrite, puis retirée au compte rendu", async () => {
  const { patient, request } = await released();
  assert.match(request.accession, /^ACC-\d{8}$/);
  const r = await syncWorklists(db.app, cfg);
  assert.ok(r.written >= 1);
  const file = join(dir, `${request.accession}.wl`);
  assert.ok(existsSync(file), "fichier .wl écrit");
  const bytes = readFileSync(file);
  assert.ok(bytes.subarray(128, 132).equals(Buffer.from("DICM")), "format DICOM Part 10");
  assert.ok(bytes.includes(Buffer.from(request.accession)), "accession dans la liste");
  const ident = (await call("reception", "GET", `/api/patients/${patient.id}`)).body
    .identifier as string;
  assert.ok(bytes.includes(Buffer.from(ident)), "identifiant patient dans la liste");
  assert.equal((await syncWorklists(db.app, cfg)).written, 0, "pas réécrit deux fois");
  assert.ok(
    !existsSync(join(dir, `.${request.accession}.wl.tmp`)),
    "aucun fichier temporaire laissé",
  );

  await call("imaging", "POST", `/api/imaging/requests/${request.id}/perform`, {}, TECH);
  assert.ok(existsSync(file), "toujours là pendant l'examen");
  await call(
    "imaging",
    "POST",
    `/api/imaging/requests/${request.id}/report`,
    { findings: "Rien à signaler", conclusion: "Normal" },
    RAD,
  );
  const after = await syncWorklists(db.app, cfg);
  assert.equal(after.removed, 1);
  assert.ok(!existsSync(file), "retirée une fois l'examen rapporté");
});

test("études rattachées par accession ; PatientID différent signalé et jamais montré ; droits du prescripteur", async () => {
  const { patient, request } = await released();
  const ident = (await call("reception", "GET", `/api/patients/${patient.id}`)).body
    .identifier as string;
  studiesByAccession.set(request.accession, [
    { id: "study-ok", patientId: ident, instances: ["inst-1", "inst-2"] },
    { id: "study-autre", patientId: "AUTRE-PATIENT", instances: ["inst-9"] },
  ]);
  assert.deepEqual(
    await syncStudies(db.app, cfg),
    { linked: 0, mismatched: 0 },
    "rien tant que l'examen n'est pas commencé",
  );
  await call("imaging", "POST", `/api/imaging/requests/${request.id}/perform`, {}, TECH);
  assert.deepEqual(await syncStudies(db.app, cfg), { linked: 1, mismatched: 1 });
  assert.deepEqual(
    await syncStudies(db.app, cfg),
    { linked: 1, mismatched: 1 },
    "rejouable sans doublon",
  );
  assert.equal(
    (
      await db.owner.query("select count(*)::int n from imaging.studies where request_id = $1", [
        request.id,
      ])
    ).rows[0].n,
    2,
  );

  const staff = await call(
    "imaging",
    "GET",
    `/api/imaging/requests/${request.id}`,
    undefined,
    TECH,
  );
  const ok = staff.body.studies.find((s: { patientMatch: boolean }) => s.patientMatch);
  const bad = staff.body.studies.find((s: { patientMatch: boolean }) => !s.patientMatch);
  assert.equal(ok.instanceCount, 2);
  assert.equal(ok.modality, "CR");
  const inst = await call(
    "imaging",
    "GET",
    `/api/imaging/studies/${ok.id}/instances`,
    undefined,
    TECH,
  );
  assert.deepEqual(inst.body.instances, [{ id: "inst-1" }, { id: "inst-2" }]);
  const png = await t.app.inject({
    method: "GET",
    url: `/api/imaging/studies/${ok.id}/instances/inst-1/preview`,
    headers: await t.as("imaging"),
  });
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers["content-type"], "image/png");
  assert.deepEqual(png.rawPayload, PNG);
  assert.equal(png.headers["cache-control"], "no-store");
  assert.equal(
    (await call("imaging", "GET", `/api/imaging/studies/${bad.id}/instances`, undefined, TECH)).body
      .error.code,
    "study_patient_mismatch",
  );
  const other = await t.app.inject({
    method: "GET",
    url: `/api/imaging/studies/${ok.id}/instances/inst-9/preview`,
    headers: await t.as("imaging"),
  });
  assert.equal(
    other.statusCode,
    404,
    "une image d'une autre étude n'est pas lisible par cette adresse",
  );

  // Le prescripteur n'a rien tant que l'examen n'est pas rapporté.
  const early = await call("doctor", "GET", `/api/imaging/requests/${request.id}`, undefined, DR);
  assert.deepEqual(early.body.studies, []);
  assert.equal(
    (await call("doctor", "GET", `/api/imaging/studies/${ok.id}/instances`, undefined, DR)).status,
    404,
  );
  await call(
    "imaging",
    "POST",
    `/api/imaging/requests/${request.id}/report`,
    { findings: "Rien à signaler", conclusion: "Normal" },
    RAD,
  );
  assert.equal(
    (await call("doctor", "GET", `/api/imaging/studies/${ok.id}/instances`, undefined, DR)).status,
    200,
  );
  assert.equal(
    (await call("doctor", "GET", `/api/imaging/studies/${bad.id}/instances`, undefined, DR)).status,
    409,
  );
  assert.ok(
    (await db.owner.query("select 1 from audit.log where action = 'imaging.study.read'"))
      .rowCount! >= 2,
    "lectures tracées",
  );
  // Rôle sans droit d'imagerie
  assert.equal(
    (await call("cashier", "GET", `/api/imaging/studies/${ok.id}/instances`, undefined, CASHIER))
      .status,
    403,
  );
});

test("Orthanc en panne : la synchronisation échoue proprement et reprend ; non configuré : 503", async () => {
  const { request } = await released();
  await call("imaging", "POST", `/api/imaging/requests/${request.id}/perform`, {}, TECH);
  down = true;
  await assert.rejects(syncStudies(db.app, cfg), /Orthanc a répondu 503/);
  down = false;
  await syncStudies(db.app, cfg);
  const t2 = await createTestApp(db.app, { pacs: null });
  try {
    const res = await t2.app.inject({
      method: "GET",
      url: "/api/imaging/studies/00000000-0000-0000-0000-000000000000/instances",
      headers: await t2.as("imaging"),
    });
    assert.equal(res.statusCode, 503);
  } finally {
    await t2.close();
  }
});

test("fichiers DICOM : en-têtes valides, identifiants dans la liste de travail (UTF-8), image de test lisible", () => {
  const wl = buildWorklistFile({
    accession: "ACC-00000042",
    familyName: "Ahmed",
    givenName: "Fatouma",
    patientId: "P-1",
    birthDate: "1990-05-06",
    sex: "female",
    modality: "CR",
    procedure: "Radio",
    scheduledDate: "2026-11-04",
    scheduledTime: "09:30",
    stationAet: "RADIO1",
  });
  assert.ok(wl.subarray(128, 132).equals(Buffer.from("DICM")));
  assert.ok(
    wl.includes(Buffer.from("AHMED")) === false && wl.includes(Buffer.from("Ahmed^Fatouma")),
  );
  assert.ok(wl.includes(Buffer.from("19900506")));
  const img = buildTestImage({
    patientId: "P-1",
    patientName: "A^B",
    accession: "ACC-00000042",
    size: 16,
  });
  assert.ok(img.length > 16 * 16);
  assert.equal(wl.length % 2, 0, "longueur paire");
});
