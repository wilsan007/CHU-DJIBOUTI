import { randomBytes } from "node:crypto";
import pg from "pg";
import { APP_ROLE, bootstrapDatabase, MIGRATOR_ROLE } from "../../src/bootstrap.ts";
import { createPool, type Db } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";

const MIGRATOR_PASSWORD = "migrator-test-only";
const APP_PASSWORD = "app-test-only";

export interface TestDatabase {
  /** Connexion du rôle de l'application (droits limités, comme en production). */
  app: Db;
  /** Connexion du propriétaire (pour préparer des données ou vérifier les garde-fous). */
  owner: Db;
  appUrl: string;
  ownerUrl: string;
  name: string;
  drop: () => Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_ADMIN_URL absent : lancez les tests avec `pnpm test`.");
  }
  return url;
}

function withCredentials(base: string, database: string, user: string, password: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Crée une base neuve et migrée, isolée des autres tests. */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  admin.on("error", () => undefined);
  const name = `chu_test_${randomBytes(6).toString("hex")}`;
  try {
    // Les rôles sont globaux au serveur : plusieurs fichiers de test peuvent les créer en même temps.
    await admin.query("select pg_advisory_lock(727002)");
    try {
      await bootstrapDatabase(admin, {
        database: name,
        migratorPassword: MIGRATOR_PASSWORD,
        appPassword: APP_PASSWORD,
      });
    } finally {
      await admin.query("select pg_advisory_unlock(727002)");
    }
  } finally {
    await admin.end();
  }
  const ownerUrl = withCredentials(adminUrl(), name, MIGRATOR_ROLE, MIGRATOR_PASSWORD);
  const appUrl = withCredentials(adminUrl(), name, APP_ROLE, APP_PASSWORD);
  const owner = createPool(ownerUrl, 4);
  if (options.migrate !== false) await migrate(owner);
  const app = createPool(appUrl, 8);
  return {
    app,
    owner,
    appUrl,
    ownerUrl,
    name,
    drop: async () => {
      await app.end();
      await owner.end();
      const cleanup = new pg.Pool({ connectionString: adminUrl(), max: 1 });
      cleanup.on("error", () => undefined);
      try {
        await cleanup.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
