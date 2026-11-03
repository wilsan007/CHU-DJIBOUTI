import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Connexion du rôle `chu_app` (droits limités). */
  DATABASE_URL: z.string().min(1),
  /** Connexion du rôle `chu_migrator` : utilisée seulement par `make migrate`. */
  DATABASE_MIGRATOR_URL: z.string().min(1).optional(),
  AUTH_ISSUER: z.string().url(),
  AUTH_AUDIENCE: z.string().min(1),
  AUTH_JWKS_URL: z.string().url(),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Lit la configuration dans les variables d'environnement ; arrête le démarrage si elle est incomplète. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`);
    throw new Error(`Configuration invalide :\n${lines.join("\n")}`);
  }
  return result.data;
}
