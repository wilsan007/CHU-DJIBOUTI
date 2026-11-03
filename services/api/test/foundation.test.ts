import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { withTransaction } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";

let t: TestDatabase;
before(async () => {
  t = await createTestDatabase();
});
after(async () => {
  await t.drop();
});

test("migrer deux fois ne change rien la seconde fois (étape 5.3)", async () => {
  const again = await migrate(t.owner);
  assert.deepEqual(again.applied, []);
  assert.ok(again.skipped.length >= 1);
});

test("une migration modifiée après coup est refusée", async () => {
  const before = await t.owner.query<{ checksum: string }>(
    "select checksum from public.schema_migrations where name like '0001%'",
  );
  const original = before.rows[0]?.checksum;
  assert.ok(original);
  await t.owner.query("update public.schema_migrations set checksum = 'x' where name like '0001%'");
  try {
    await assert.rejects(() => migrate(t.owner), /modifiée après son application/);
  } finally {
    await t.owner.query(
      "update public.schema_migrations set checksum = $1 where name like '0001%'",
      [original],
    );
  }
});

test("l'application ne peut ni modifier ni supprimer le journal d'audit (étape 5.6)", async () => {
  await t.app.query(
    "insert into audit.log (actor_id, action, entity_type) values ('u1', 'test.action', 'test')",
  );
  await assert.rejects(
    () => t.app.query("update audit.log set action = 'x'"),
    /permission denied|ajout seul/,
  );
  await assert.rejects(() => t.app.query("delete from audit.log"), /permission denied|ajout seul/);
  await assert.rejects(() => t.app.query("truncate audit.log"), /permission denied|ajout seul/);
});

test("même le propriétaire de la base est arrêté par le déclencheur d'ajout seul", async () => {
  await assert.rejects(() => t.owner.query("update audit.log set action = 'x'"), /ajout seul/);
  await assert.rejects(() => t.owner.query("delete from audit.log"), /ajout seul/);
});

test("la table des événements est aussi en ajout seul", async () => {
  await t.app.query(
    `insert into events.outbox (event_id, type, version, occurred_at, actor, payload)
     values ($1, 'PatientCreated', 1, now(), '{}', '{}')`,
    [randomUUID()],
  );
  await assert.rejects(
    () => t.app.query("update events.outbox set type = 'x'"),
    /permission denied|ajout seul/,
  );
  await assert.rejects(() => t.owner.query("delete from events.outbox"), /ajout seul/);
});

test("withTransaction annule tout si une erreur survient", async () => {
  const id = randomUUID();
  await assert.rejects(() =>
    withTransaction(t.app, async (tx) => {
      await tx.query(
        `insert into events.outbox (event_id, type, version, occurred_at, actor, payload)
         values ($1, 'PatientCreated', 1, now(), '{}', '{}')`,
        [id],
      );
      throw new Error("échec volontaire");
    }),
  );
  const found = await t.app.query("select 1 from events.outbox where event_id = $1", [id]);
  assert.equal(found.rowCount, 0);
});
