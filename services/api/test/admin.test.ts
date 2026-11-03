import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Role } from "../src/auth/permissions.ts";
import type { UserDirectory } from "../src/modules/admin/directory.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import { makeCaller, type Caller } from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const calls: string[] = [];
let failEnable = false;

const directory: UserDirectory = {
  createUser: async (input) => {
    calls.push(`create:${input.username}:${input.role}`);
    return { id: "kc-new-user" };
  },
  setEnabled: async (id, enabled) => {
    if (failEnable) throw new Error("Keycloak indisponible");
    calls.push(`enabled:${id}:${enabled}`);
  },
  setRole: async (id, role: Role) => {
    calls.push(`role:${id}:${role}`);
  },
};

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app, { directory });
  call = makeCaller(t);
});
after(async () => {
  await t.close();
  await db.drop();
});

test("F14-1 : un compte désactivé perd l'accès à tous les modules tout de suite, avec un jeton encore valide", async () => {
  // Le compte s'enregistre à sa première requête.
  assert.equal((await call("doctor", "GET", "/api/lab/tests", undefined, "dr-parti")).status, 200);
  assert.equal(
    (await call("pharmacy", "GET", "/api/stock/depots", undefined, "ph-parti")).status,
    200,
  );
  assert.equal((await call("doctor", "GET", "/api/lab/tests", undefined, "dr-parti")).status, 200);

  const dis = await call(
    "admin",
    "POST",
    "/api/admin/users/dr-parti/disable",
    { reason: "Départ du service" },
    "admin-1",
  );
  assert.equal(dis.status, 200, dis.raw);
  assert.deepEqual([dis.body.status, dis.body.directorySync], ["disabled", true]);
  assert.ok(calls.includes("enabled:dr-parti:false"), "l'annuaire est synchronisé");

  for (const [role, url] of [
    ["doctor", "/api/lab/tests"],
    ["doctor", "/api/patients?q=abc"],
    ["doctor", "/api/consultations/x"],
  ] as const) {
    const res = await call(role, "GET", url, undefined, "dr-parti");
    assert.equal(res.status, 403, url);
    assert.equal(res.body.error.code, "account_disabled");
  }
  assert.equal(
    (await call("pharmacy", "GET", "/api/stock/depots", undefined, "ph-parti")).status,
    200,
    "les autres comptes ne sont pas touchés",
  );

  const list = await call("admin", "GET", "/api/admin/users?status=disabled", undefined, "admin-1");
  assert.deepEqual(
    list.body.users.map((u: { id: string; disabledBy: string }) => [u.id, u.disabledBy]),
    [["dr-parti", "admin-1"]],
  );
  assert.equal(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'admin.user.disable' and entity_id = 'dr-parti'",
      )
    ).rowCount,
    1,
  );

  const en = await call("admin", "POST", "/api/admin/users/dr-parti/enable", {}, "admin-1");
  assert.equal(en.body.status, "active");
  assert.equal((await call("doctor", "GET", "/api/lab/tests", undefined, "dr-parti")).status, 200);
});

test("F14-1 : droits de l'administration, pas d'auto-désactivation, compte inconnu, annuaire en panne", async () => {
  assert.equal((await call("doctor", "GET", "/api/admin/users")).status, 403);
  assert.equal(
    (await call("direction", "POST", "/api/admin/users/x/disable", { reason: "test" })).status,
    403,
  );
  assert.equal(
    (
      await call(
        "admin",
        "POST",
        "/api/admin/users/admin-1/disable",
        { reason: "moi-même" },
        "admin-1",
      )
    ).body.error.code,
    "cannot_disable_self",
  );
  assert.equal(
    (await call("admin", "POST", "/api/admin/users/inconnu/disable", { reason: "test" }, "admin-1"))
      .status,
    404,
  );
  assert.equal(
    (await call("admin", "POST", "/api/admin/users/ph-parti/disable", { reason: "x" }, "admin-1"))
      .status,
    400,
    "motif trop court",
  );

  failEnable = true;
  const dis = await call(
    "admin",
    "POST",
    "/api/admin/users/ph-parti/disable",
    { reason: "Congé long" },
    "admin-1",
  );
  failEnable = false;
  assert.equal(dis.status, 200, "la désactivation locale réussit même si l'annuaire est en panne");
  assert.equal(dis.body.directorySync, false);
  assert.equal(
    (await call("pharmacy", "GET", "/api/stock/depots", undefined, "ph-parti")).status,
    403,
  );
});

test("F14-1 : création d'un compte avec un seul rôle, changement de rôle, rôle inconnu refusé", async () => {
  const create = await call(
    "admin",
    "POST",
    "/api/admin/users",
    {
      username: "nouveau.caissier",
      email: "n.caissier@chu.invalid",
      role: "cashier",
      temporaryPassword: "Mot-de-passe-temporaire-1",
    },
    "admin-1",
  );
  assert.equal(create.status, 201, create.raw);
  assert.deepEqual(create.body.roles, ["cashier"]);
  assert.ok(calls.includes("create:nouveau.caissier:cashier"));
  const ch = await call(
    "admin",
    "PUT",
    "/api/admin/users/kc-new-user/role",
    { role: "reception" },
    "admin-1",
  );
  assert.deepEqual(ch.body.roles, ["reception"]);
  assert.equal(
    (
      await call(
        "admin",
        "POST",
        "/api/admin/users",
        {
          username: "x.y",
          email: "x@chu.invalid",
          role: "pirate",
          temporaryPassword: "Mot-de-passe-temporaire-1",
        },
        "admin-1",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "admin",
        "POST",
        "/api/admin/users",
        { username: "x.y", email: "x@chu.invalid", role: "cashier", temporaryPassword: "court" },
        "admin-1",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await db.owner.query(
        "select 1 from audit.log where action in ('admin.user.create','admin.user.role')",
      )
    ).rowCount,
    2,
  );
});

test("sans annuaire configuré, la création de compte est refusée clairement", async () => {
  const bare = await createTestApp(db.app);
  try {
    const c = makeCaller(bare);
    const res = await c(
      "admin",
      "POST",
      "/api/admin/users",
      {
        username: "a.b.c",
        email: "a@chu.invalid",
        role: "cashier",
        temporaryPassword: "Mot-de-passe-temporaire-1",
      },
      "admin-1",
    );
    assert.equal(res.status, 501);
    assert.equal(res.body.error.code, "directory_not_configured");
  } finally {
    await bare.close();
  }
});

test("le registre ne garde que le nécessaire et ne se supprime pas par l'application", async () => {
  await assert.rejects(db.app.query("delete from admin.users"), /permission denied/);
});
