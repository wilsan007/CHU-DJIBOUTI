import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

const LOCK_KEY = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applique les migrations SQL dans l'ordre des noms de fichier. Une migration déjà appliquée n'est
 * jamais rejouée ; si son contenu a changé depuis, on s'arrête (on ne modifie pas l'histoire : on
 * ajoute une nouvelle migration).
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await db.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      create table if not exists public.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const done = new Map<string, string>();
    const rows = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from public.schema_migrations",
    );
    for (const row of rows.rows) done.set(row.name, row.checksum);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `La migration ${file} a été modifiée après son application. Ajoutez une nouvelle migration.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          "insert into public.schema_migrations (name, checksum) values ($1, $2)",
          [file, checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Échec de la migration ${file} : ${(error as Error).message}`, {
          cause: error,
        });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
