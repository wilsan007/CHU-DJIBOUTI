import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { writeAudit, type RequestContext } from "../src/audit/audit.ts";
import {
  Dispatcher,
  listDeadLetters,
  retryDeadLetter,
  type Consumer,
  type DeadLetterInfo,
} from "../src/events/dispatcher.ts";
import { createPatient } from "../src/modules/identity/service.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";

// Une base neuve par test : les événements des autres tests ne perturbent pas les comptes.
let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
  counter = 0;
});
afterEach(async () => {
  await db.drop();
});

const ctx: RequestContext = {
  user: { id: "u-test", name: "test", roles: ["reception"] },
  requestId: "req-test",
};
let counter = 0;
async function emitPatientCreated(): Promise<string> {
  counter += 1;
  const { patient } = await createPatient(db.app, ctx, {
    givenName: `Dist${counter}`,
    familyName: `Test${counter}`,
    sex: "male",
    birthDate: "1990-01-01",
    phone: `00 11 ${String(counter).padStart(2, "0")} 00`,
    confirmNotDuplicate: true,
  });
  return patient.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("un consommateur reçoit les événements de ses types, dans l'ordre, une seule fois", async () => {
  const seen: string[] = [];
  const consumer: Consumer = {
    name: "temoin-ordre",
    types: ["PatientCreated"],
    handle: async (event) => {
      seen.push(event.patientId ?? "");
    },
  };
  const before = (
    await db.owner.query(
      "select count(*)::int as n from events.outbox where type = 'PatientCreated'",
    )
  ).rows[0].n;
  const a = await emitPatientCreated();
  const b = await emitPatientCreated();
  const c = await emitPatientCreated();
  const dispatcher = new Dispatcher({ db: db.app, consumers: [consumer] });
  const n = await dispatcher.drain();
  assert.equal(n, before + 3);
  assert.deepEqual(seen.slice(-3), [a, b, c]);
  assert.equal(await dispatcher.drain(), 0, "rien de nouveau au second passage");
});

test("un consommateur ne reçoit pas les types auxquels il n'est pas abonné", async () => {
  await emitPatientCreated();
  const seen: string[] = [];
  const dispatcher = new Dispatcher({
    db: db.app,
    consumers: [
      {
        name: "temoin-types",
        types: ["PatientMerged"],
        handle: async (e) => void seen.push(e.type),
      },
    ],
  });
  await dispatcher.drain();
  assert.deepEqual(seen, []);
  const cursor = await db.owner.query(
    "select last_id from events.consumer_cursor where consumer = 'temoin-types'",
  );
  const max = await db.owner.query("select max(id) as m from events.outbox");
  assert.equal(cursor.rows[0].last_id, max.rows[0].m, "le curseur avance quand même");
});

test("idempotence : un événement déjà traité n'est jamais rejoué, même curseur remis à zéro", async () => {
  await emitPatientCreated();
  let calls = 0;
  const dispatcher = new Dispatcher({
    db: db.app,
    consumers: [
      { name: "temoin-idem", types: ["PatientCreated"], handle: async () => void (calls += 1) },
    ],
  });
  await dispatcher.drain();
  const first = calls;
  assert.ok(first >= 1);
  await db.owner.query(
    "update events.consumer_cursor set last_id = 0 where consumer = 'temoin-idem'",
  );
  await dispatcher.drain();
  assert.equal(calls, first, "le gestionnaire n'est pas rappelé");
  const cursor = await db.owner.query(
    "select last_id from events.consumer_cursor where consumer = 'temoin-idem'",
  );
  assert.notEqual(cursor.rows[0].last_id, "0", "le curseur est reparti de l'avant");
});

test("l'effet d'un consommateur et son suivi sont atomiques : une erreur annule l'effet", async () => {
  await emitPatientCreated();
  const dispatcher = new Dispatcher({
    db: db.app,
    maxAttempts: 1,
    consumers: [
      {
        name: "temoin-atomique",
        types: ["PatientCreated"],
        handle: async (_event, tx, c) => {
          await writeAudit(tx, c, { action: "test.effet", entityType: "test" });
          throw new Error("échec après un effet");
        },
      },
    ],
  });
  await dispatcher.drain();
  const effects = await db.owner.query(
    "select count(*)::int as n from audit.log where action = 'test.effet'",
  );
  assert.equal(effects.rows[0].n, 0, "l'effet a été annulé");
  const processed = await db.owner.query(
    "select count(*)::int as n from events.processed where consumer = 'temoin-atomique'",
  );
  assert.equal(processed.rows[0].n, 0, "l'événement n'est pas marqué traité");
});

test("reprise avec délais croissants : rien avant l'heure, puis succès, un seul effet", async () => {
  await emitPatientCreated();
  let now = new Date("2026-11-03T10:00:00Z");
  let attempts = 0;
  let effects = 0;
  const dispatcher = new Dispatcher({
    db: db.app,
    baseDelayMs: 1000,
    now: () => now,
    consumers: [
      {
        name: "temoin-reprise",
        types: ["PatientCreated"],
        handle: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`panne ${attempts}`);
          effects += 1;
        },
      },
    ],
  });
  await dispatcher.runOnce(); // essai 1 : échec, prochain essai dans 1 s
  assert.equal(attempts, 1);
  await dispatcher.runOnce(); // trop tôt
  assert.equal(attempts, 1, "pas de nouvel essai avant l'heure");
  now = new Date(now.getTime() + 1500);
  await dispatcher.runOnce(); // essai 2 : échec, prochain essai dans 2 s
  assert.equal(attempts, 2);
  now = new Date(now.getTime() + 1500);
  await dispatcher.runOnce();
  assert.equal(attempts, 2, "le délai a doublé : 1,5 s ne suffit plus");
  now = new Date(now.getTime() + 1000);
  await dispatcher.drain(); // essai 3 : succès
  assert.equal(attempts, 3);
  assert.ok(effects >= 1);
  const failures = await db.owner.query(
    "select count(*)::int as n from events.failures where consumer = 'temoin-reprise'",
  );
  assert.equal(failures.rows[0].n, 0, "la trace d'échec disparaît après le succès");
});

test("abandon après trop d'essais : file des échecs, alerte, les événements suivants continuent", async () => {
  const bad = await emitPatientCreated();
  const good = await emitPatientCreated();
  let now = new Date("2026-11-03T10:00:00Z");
  const handled: string[] = [];
  const dead: DeadLetterInfo[] = [];
  const dispatcher = new Dispatcher({
    db: db.app,
    maxAttempts: 3,
    baseDelayMs: 10,
    now: () => now,
    onDead: (info) => dead.push(info),
    consumers: [
      {
        name: "temoin-abandon",
        types: ["PatientCreated"],
        handle: async (event) => {
          if (event.patientId === bad) throw new Error("événement empoisonné");
          handled.push(event.patientId ?? "");
        },
      },
    ],
  });
  for (let i = 0; i < 5; i += 1) {
    await dispatcher.runOnce();
    now = new Date(now.getTime() + 1000);
  }
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.attempts, 3);
  assert.match(dead[0]?.error ?? "", /empoisonné/);
  assert.ok(handled.includes(good), "l'événement suivant a été traité");
  const list = await listDeadLetters(db.app);
  assert.equal(list.length, 1);

  // Après correction de la cause, l'événement abandonné peut être remis en file.
  const retried = await retryDeadLetter(db.owner, "temoin-abandon", list[0]?.eventId ?? "");
  assert.equal(retried, true);
});

test("un consommateur lent ne bloque pas les autres", async () => {
  await emitPatientCreated();
  await emitPatientCreated();
  const done: Record<string, number> = {};
  const started = Date.now();
  const dispatcher = new Dispatcher({
    db: db.app,
    consumers: [
      {
        name: "lent",
        types: ["PatientCreated"],
        handle: async () => {
          await sleep(250);
          done.lent = Date.now() - started;
        },
      },
      {
        name: "rapide",
        types: ["PatientCreated"],
        handle: async () => {
          done.rapide = Date.now() - started;
        },
      },
    ],
  });
  await dispatcher.runOnce();
  assert.ok(done.rapide !== undefined && done.lent !== undefined);
  assert.ok(done.rapide < 200, `le rapide a fini en ${done.rapide} ms`);
  assert.ok(done.lent >= 250);
});

test("deux distributeurs en même temps : chaque événement n'est traité qu'une fois", async () => {
  for (let i = 0; i < 6; i += 1) await emitPatientCreated();
  let calls = 0;
  const make = () =>
    new Dispatcher({
      db: db.app,
      consumers: [
        {
          name: "temoin-concurrence",
          types: ["PatientCreated"],
          handle: async () => {
            await sleep(5);
            calls += 1;
          },
        },
      ],
    });
  const expected = (
    await db.owner.query(
      "select count(*)::int as n from events.outbox where type = 'PatientCreated'",
    )
  ).rows[0].n;
  const a = make();
  const b = make();
  for (let i = 0; i < 3; i += 1) await Promise.all([a.runOnce(), b.runOnce()]);
  await a.drain();
  assert.equal(calls, expected);
});

test("la boucle de fond traite les nouveaux événements sans intervention", async () => {
  const seen: string[] = [];
  const dispatcher = new Dispatcher({
    db: db.app,
    consumers: [
      {
        name: "temoin-boucle",
        types: ["PatientCreated"],
        handle: async (e) => void seen.push(e.patientId ?? ""),
      },
    ],
  });
  dispatcher.start(20);
  const id = await emitPatientCreated();
  for (let i = 0; i < 50 && !seen.includes(id); i += 1) await sleep(20);
  await dispatcher.stop();
  assert.ok(seen.includes(id));
});

test("deux consommateurs du même nom sont refusés", () => {
  const c: Consumer = { name: "x", types: [], handle: async () => {} };
  assert.throws(() => new Dispatcher({ db: db.app, consumers: [c, c] }));
});
