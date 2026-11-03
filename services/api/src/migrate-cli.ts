import { createPool } from "./db.ts";
import { migrate } from "./migrate.ts";

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  console.error("DATABASE_MIGRATOR_URL est obligatoire (connexion du rôle chu_migrator).");
  process.exit(1);
}
const db = createPool(url, 2);
try {
  const { applied, skipped } = await migrate(db);
  console.log(`Migrations appliquées : ${applied.length ? applied.join(", ") : "aucune"}`);
  console.log(`Déjà en place : ${skipped.length}`);
} finally {
  await db.end();
}
