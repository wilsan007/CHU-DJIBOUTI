import { bootstrapDatabase } from "./bootstrap.ts";
import { createPool } from "./db.ts";

/** Prépare un serveur PostgreSQL vierge (rôles et base). Les mots de passe viennent de l'environnement. */
const { DATABASE_ADMIN_URL, CHU_DB_NAME, CHU_MIGRATOR_PASSWORD, CHU_APP_PASSWORD } = process.env;
if (!DATABASE_ADMIN_URL || !CHU_MIGRATOR_PASSWORD || !CHU_APP_PASSWORD) {
  console.error(
    "DATABASE_ADMIN_URL, CHU_MIGRATOR_PASSWORD et CHU_APP_PASSWORD sont obligatoires (CHU_DB_NAME vaut « chu » par défaut).",
  );
  process.exit(1);
}
const admin = createPool(DATABASE_ADMIN_URL, 1);
try {
  await bootstrapDatabase(admin, {
    database: CHU_DB_NAME ?? "chu",
    migratorPassword: CHU_MIGRATOR_PASSWORD,
    appPassword: CHU_APP_PASSWORD,
  });
  console.log("Rôles et base prêts.");
} finally {
  await admin.end();
}
