import type { Db } from "./db.ts";

export const MIGRATOR_ROLE = "chu_migrator";
export const APP_ROLE = "chu_app";

export interface BootstrapOptions {
  database: string;
  migratorPassword: string;
  appPassword: string;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Prépare un serveur PostgreSQL vierge : deux rôles et une base.
 * - `chu_migrator` possède la base et applique les migrations.
 * - `chu_app` est le rôle de l'application : il n'a que les droits donnés par les migrations
 *   (par exemple, jamais le droit de modifier le journal d'audit).
 * À lancer avec un compte d'administration, une seule fois par serveur.
 */
export async function bootstrapDatabase(admin: Db, o: BootstrapOptions): Promise<void> {
  for (const [role, password] of [
    [MIGRATOR_ROLE, o.migratorPassword],
    [APP_ROLE, o.appPassword],
  ] as const) {
    const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
    const verb = exists.rowCount ? "alter" : "create";
    await admin.query(
      `${verb} role ${quoteIdent(role)} login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole`,
    );
  }
  const db = await admin.query("select 1 from pg_database where datname = $1", [o.database]);
  if (!db.rowCount) {
    await admin.query(
      `create database ${quoteIdent(o.database)} owner ${quoteIdent(MIGRATOR_ROLE)} encoding 'UTF8'`,
    );
  }
}
