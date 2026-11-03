import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Role } from "../src/auth/permissions.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";

let db: TestDatabase;
let t: TestApp;
before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
});
after(async () => {
  await t.close();
  await db.drop();
});

const newPatient = {
  givenName: "Hodan",
  familyName: "Moussa",
  sex: "female",
  estimatedAge: 28,
  phone: "00 00 00 01",
};

test("/health répond sans jeton et vérifie la base", async () => {
  const res = await t.app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", db: "ok" });
});

test("sans jeton : 401", async () => {
  const res = await t.app.inject({ method: "GET", url: "/api/patients?q=hodan" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "unauthenticated");
});

test("jeton invalide, expiré, d'un autre émetteur ou d'un autre public : 401", async () => {
  const bad = [
    "Bearer n-importe-quoi",
    `Bearer ${await t.token(["reception"], { expiresIn: "-1m" })}`,
    `Bearer ${await t.token(["reception"], { issuer: "https://autre.example/realms/x" })}`,
    `Bearer ${await t.token(["reception"], { audience: "autre-api" })}`,
  ];
  for (const authorization of bad) {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/patients?q=hodan",
      headers: { authorization },
    });
    assert.equal(res.statusCode, 401, authorization.slice(0, 40));
  }
});

test("un rôle inconnu de l'application n'ouvre aucun droit", async () => {
  const res = await t.app.inject({
    method: "GET",
    url: "/api/patients?q=hodan",
    headers: await t.as("super-admin" as Role),
  });
  assert.equal(res.statusCode, 403);
});

test("chaque rôle ne passe que par ses droits (étape 5.5)", async () => {
  const create = (roles: Role[]) =>
    t.as(...roles).then((headers) =>
      t.app.inject({
        method: "POST",
        url: "/api/patients",
        headers,
        payload: { ...newPatient, confirmNotDuplicate: true },
      }),
    );
  // Peuvent créer : reception, doctor, nurse, admin. Les autres reçoivent 403.
  for (const role of ROLES) {
    const res = await create([role]);
    const expected = can([role], "patient:create") ? 201 : 403;
    assert.equal(res.statusCode, expected, `${role} -> ${res.statusCode}`);
  }
  // Lecture : la direction n'a pas accès aux patients ; le laboratoire, oui.
  const direction = await t.app.inject({
    method: "GET",
    url: "/api/patients?q=hodan",
    headers: await t.as("direction"),
  });
  assert.equal(direction.statusCode, 403);
  const lab = await t.app.inject({
    method: "GET",
    url: "/api/patients?q=hodan",
    headers: await t.as("lab"),
  });
  assert.equal(lab.statusCode, 200);
});

test("matrice des droits : séparation des tâches", () => {
  const has = (role: Role, p: (typeof PERMISSIONS)[number]) => ROLE_PERMISSIONS[role].includes(p);
  // Le laboratoire n'ouvre pas la caisse ; la caisse n'ouvre pas le clinique ni le laboratoire.
  for (const p of ["billing:read", "billing:admit", "billing:pay", "billing:credit"] as const) {
    assert.equal(has("lab", p), false);
    assert.equal(has("biologist", p), false);
  }
  for (const p of [
    "clinical:read",
    "clinical:write",
    "lab:read",
    "lab:write",
    "prescription:write",
    "order:place",
  ] as const) {
    assert.equal(has("cashier", p), false);
    assert.equal(has("reception", p), false);
  }
  // Validation en deux temps : deux rôles distincts, aucun ne cumule.
  assert.equal(has("lab", "lab:validate-tech"), true);
  assert.equal(has("lab", "lab:validate-bio"), false);
  assert.equal(has("biologist", "lab:validate-bio"), true);
  assert.equal(has("biologist", "lab:validate-tech"), false);
  // Seule l'administration fusionne ou importe ; seule elle lit l'audit.
  for (const role of ROLES) {
    assert.equal(has(role, "patient:merge"), role === "admin");
    assert.equal(has(role, "patient:import"), role === "admin");
    assert.equal(has(role, "audit:read"), role === "admin");
  }
  // La direction ne voit que des chiffres agrégés, aucun dossier ni aucune facture.
  assert.deepEqual([...ROLE_PERMISSIONS.direction].sort(), [
    "billing:discount-any",
    "billing:report",
    "dashboard:read",
    "stay:exit-unpaid",
  ]);
  // Remises : la caisse jusqu'au plafond, la direction au-delà ; jamais le médecin ni le service.
  for (const role of ROLES) {
    assert.equal(has(role, "billing:discount"), role === "cashier", `${role} billing:discount`);
    assert.equal(has(role, "billing:discount-any"), role === "direction", `${role} discount-any`);
    assert.equal(has(role, "stay:discharge"), role === "doctor", `${role} stay:discharge`);
  }
  // Règle de la caisse : seule la caisse valide un paiement et remet le bon de prestations ;
  // seuls médecin et infirmier demandent des prestations ; seuls les services reçoivent des tickets.
  for (const role of ROLES) {
    assert.equal(has(role, "billing:pay"), role === "cashier", `${role} billing:pay`);
    assert.equal(has(role, "voucher:print"), role === "cashier", `${role} voucher:print`);
    assert.equal(
      has(role, "order:place"),
      role === "doctor" || role === "nurse",
      `${role} order:place`,
    );
    assert.equal(
      has(role, "ticket:work"),
      ["lab", "biologist", "imaging", "nurse"].includes(role),
      `${role} ticket:work`,
    );
    assert.equal(has(role, "billing:admit"), role === "reception", `${role} billing:admit`);
    assert.equal(has(role, "catalog:manage"), role === "admin", `${role} catalog:manage`);
    assert.equal(has(role, "schedule:manage"), role === "admin", `${role} schedule:manage`);
  }
  // Un médecin ne s'encaisse pas lui-même : qui demande ne valide pas le paiement.
  assert.equal(has("doctor", "billing:pay"), false);
  // Seule la pharmacie dispense.
  for (const role of ROLES) assert.equal(has(role, "pharmacy:dispense"), role === "pharmacy");
});

test("/api/me renvoie l'identité, les rôles et les droits de la personne connectée", async () => {
  const t = await createTestApp(
    // Pas de base nécessaire : /api/me ne lit que le jeton ; la requête de contrôle de compte est neutralisée.
    {
      query: async () => ({ rows: [{ status: "active", roles: ["cashier"], stale: false }] }),
    } as never,
  );
  try {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: await t.as("cashier"),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { roles: string[]; permissions: string[] };
    assert.deepEqual(body.roles, ["cashier"]);
    assert.ok(
      body.permissions.includes("billing:pay") && !body.permissions.includes("clinical:read"),
    );
    assert.equal((await t.app.inject({ method: "GET", url: "/api/me" })).statusCode, 401);
  } finally {
    await t.close();
  }
});

test("magasin et ressources humaines : aucun accès aux dossiers de patients, chacun son domaine", () => {
  const has = (role: Role, p: (typeof PERMISSIONS)[number]) => ROLE_PERMISSIONS[role].includes(p);
  for (const role of ["storekeeper", "hr"] as const) {
    for (const p of [
      "patient:read",
      "clinical:read",
      "prescription:read",
      "lab:read",
      "billing:read",
      "imaging:read",
    ] as const)
      assert.equal(has(role, p), false, `${role} ${p}`);
  }
  for (const role of ROLES) {
    assert.equal(has(role, "staff:manage"), role === "hr", `${role} staff:manage`);
    assert.equal(has(role, "staff:roster"), role === "hr", `${role} staff:roster`);
    assert.equal(has(role, "leave:approve"), role === "hr", `${role} leave:approve`);
    assert.equal(
      has(role, "stock:recipes"),
      role === "storekeeper" || role === "admin",
      `${role} stock:recipes`,
    );
    assert.equal(has(role, "staff:directory"), role !== "direction", `${role} staff:directory`);
  }
  // Les médicaments : pharmacie ; consommables et réactifs : magasin ; les services consomment sans gérer.
  assert.equal(has("pharmacy", "stock:manage") && has("storekeeper", "stock:manage"), true);
  for (const role of ["doctor", "nurse", "lab", "biologist", "imaging"] as const) {
    assert.equal(has(role, "stock:consume"), true, `${role} consomme`);
    assert.equal(has(role, "stock:manage"), false, `${role} ne gère pas le stock`);
  }
});
