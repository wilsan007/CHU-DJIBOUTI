import { buildApp } from "./app.ts";
import { createTokenVerifier, remoteKeys } from "./auth/jwt.ts";
import { loadConfig } from "./config.ts";
import { allConsumers } from "./consumers.ts";
import { createPool } from "./db.ts";
import { Dispatcher } from "./events/dispatcher.ts";
import { keycloakDirectory } from "./modules/admin/directory.ts";
import { escalateOverdue } from "./modules/lab/service.ts";
import { pacsConfigFromEnv, syncStudies, syncWorklists } from "./modules/imaging/pacs.ts";
import { portalConfigFromEnv } from "./modules/portal/service.ts";
import { providerFromEnv } from "./common/sms.ts";
import { sendDueReminders, type NotificationProvider } from "./modules/appointments/reminders.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const pacs = pacsConfigFromEnv(process.env);
// Rappels de rendez-vous et codes du portail patient : passerelle SMS HTTP configurable (SMS_GATEWAY_URL…) ; sans
// configuration, les messages sont seulement écrits dans le journal du service (aucun envoi réel). WhatsApp s'ajoutera
// comme second fournisseur. ATTENTION : sans passerelle, les codes de connexion apparaissent dans le journal.
// `app` n'existe pas encore : la fermeture ne sera appelée qu'après sa création.
let appLog: (m: string) => void = () => {};
const provider: NotificationProvider = providerFromEnv(process.env, (m) => appLog(m));
const app = await buildApp({
  db,
  pacs,
  portal: portalConfigFromEnv(process.env, provider),
  ...(process.env.TRUST_PROXY
    ? { trustProxy: process.env.TRUST_PROXY === "true" ? true : process.env.TRUST_PROXY }
    : {}),
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

appLog = (m) => app.log.info(m);
const reminderTimer = setInterval(
  () => {
    sendDueReminders(db, provider).catch((error) =>
      app.log.error({ err: error }, "échec de l'envoi des rappels"),
    );
  },
  Number(process.env.REMINDER_INTERVAL_MS ?? 60_000),
);

// Serveur d'images DICOM (Orthanc), s'il est configuré : listes de travail pour les appareils, études rattachées aux examens.
const pacsTimer = pacs
  ? setInterval(
      () => {
        syncWorklists(db, pacs)
          .then(() => syncStudies(db, pacs))
          .catch((error) => app.log.error({ err: error }, "synchronisation du serveur d'images"));
      },
      Number(process.env.PACS_SYNC_INTERVAL_MS ?? 15_000),
    )
  : undefined;

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
  if (pacsTimer) clearInterval(pacsTimer);
  await dispatcher.stop();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await app.listen({ port: config.PORT, host: config.HOST });
