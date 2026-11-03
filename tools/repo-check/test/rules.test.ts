import assert from "node:assert/strict";
import { test } from "node:test";
import { envExampleValueLines, findSecret, isForbiddenPath } from "../src/rules.ts";

test("fichiers interdits : .env, clés, sauvegardes", () => {
  for (const p of [
    ".env",
    ".env.production",
    "infra/.env.local",
    "certs/server.key",
    "a/b/id.pem",
    "backup/db.dump",
    "x/y.sql.gz",
    "secrets/token.txt",
  ]) {
    assert.equal(isForbiddenPath(p), true, p);
  }
});

test("fichiers autorisés : .env.example et sources ordinaires", () => {
  for (const p of [".env.example", "services/api/.env.example", "README.md", "src/keyboard.ts"]) {
    assert.equal(isForbiddenPath(p), false, p);
  }
});

test("détection de secrets dans le contenu", () => {
  // Les marqueurs sont coupés en deux pour que ce fichier ne soit pas lui-même détecté comme un secret.
  const begin = "-----BEGIN ";
  assert.equal(findSecret(`${begin}RSA PRIVATE KEY-----\nabc`), "clé privée");
  assert.equal(findSecret(`${begin}PRIVATE KEY-----`), "clé privée");
  assert.equal(findSecret("token=ghp_" + "a".repeat(36)), "jeton d'accès GitHub");
  assert.equal(findSecret("export const nom = 'Fatouma';"), null);
});

test(".env.example : seuls les noms sont autorisés", () => {
  const ok = "# commentaire\nKEYCLOAK_REALM=               # chu\nTZ=\n\nCHU_ENV=   \n";
  assert.deepEqual(envExampleValueLines(ok), []);
  const bad = "A=\nPASSWORD=secret\nB=1 # note\n";
  assert.deepEqual(envExampleValueLines(bad), [2, 3]);
});
