import { buildApp } from "./app.ts";
import { createTokenVerifier, remoteKeys } from "./auth/jwt.ts";
import { loadConfig } from "./config.ts";
import { allConsumers } from "./consumers.ts";
import { createPool } from "./db.ts";
import { Dispatcher } from "./events/dispatcher.ts";
import { keycloakDirectory } from "./modules/admin/directory.ts";
import { escalateOverdue } from "./modules/lab/service.ts";
import { providerFromEnv } from "./common/sms.ts";
import { sendDueReminders, type NotificationProvider } from "./modules/appointments/reminders.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = await buildApp({
  db,
  verifier: createTokenVerifier({
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    keys: remoteKeys(config.AUTH_JWKS_URL),
  }),
  logger: config.LOG_LEVEL !== "silent",
  // Gestion des comptes par Keycloak : facultative (sans elle, seule la désactivation locale est possible).
  directory:
    process.env.KEYCLOAK_ADMIN_URL && process.env.KEYCLOAK_ADMIN_CLIENT_SECRET
      ? keycloakDirectory({
          baseUrl: process.env.KEYCLOAK_ADMIN_URL,
          realm: process.env.KEYCLOAK_REALM ?? "chu",
          clientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? "chu-admin-api",
          clientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET,
        })
      : null,
});

// Le distributeur fait circuler les événements entre modules (ordonnance, paiement, ticket...).
const dispatcher = new Dispatcher({
  db,
  consumers: allConsumers(),
  onError: (consumer, error) =>
    app.log.error({ consumer, err: error }, "échec d'un consommateur d'événements"),
  onDead: (info) => app.log.error(info, "ALERTE : événement abandonné, intervention nécessaire"),
});
dispatcher.start(Number(process.env.DISPATCH_INTERVAL_MS ?? 500));

// Rappels de rendez-vous : passerelle SMS HTTP configurable (SMS_GATEWAY_URL…) ; sans configuration, les messages
// sont seulement écrits dans le journal du service (aucun envoi réel). WhatsApp s'ajoutera comme second fournisseur.
const provider: NotificationProvider = providerFromEnv(process.env, (m) => app.log.info(m));
const reminderTimer = setInterval(
  () => {
    sendDueReminders(db, provider).catch((error) =>
      app.log.error({ err: error }, "échec de l'envoi des rappels"),
    );
  },
  Number(process.env.REMINDER_INTERVAL_MS ?? 60_000),
);

// Valeurs critiques non acquittées : escalade vers le responsable désigné par le biologiste.
const escalationTimer = setInterval(
  () => {
    escalateOverdue(db).catch((error) =>
      app.log.error({ err: error }, "échec de l'escalade des valeurs critiques"),
    );
  },
  Number(process.env.ESCALATION_INTERVAL_MS ?? 60_000),
);

const stop = async () => {
  clearInterval(reminderTimer);
  clearInterval(escalationTimer);
  await dispatcher.stop();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await app.listen({ port: config.PORT, host: config.HOST });
