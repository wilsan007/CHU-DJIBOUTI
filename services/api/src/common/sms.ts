import type { NotificationProvider } from "../modules/appointments/reminders.ts";

/**
 * Numéro de Djibouti au format international E.164 (+253 puis 8 chiffres). Accepte « 77 12 34 56 »,
 * « 0077123456 », « 00253 77 12 34 56 », « +253 77123456 ». Refuse tout ce qui ne ressemble pas à un numéro.
 */
export function normalizePhone(raw: string, countryCode = "253", localLength = 8): string {
  const digits = raw.replace(/[\s().-]/g, "");
  let d = digits.startsWith("+") ? digits.slice(1) : digits;
  if (!/^\d+$/.test(d)) throw new Error("numéro invalide");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith(countryCode) && d.length === countryCode.length + localLength) return `+${d}`;
  if (d.length === localLength) return `+${countryCode}${d}`;
  throw new Error("numéro invalide");
}

export const maskPhone = (phone: string): string => `${phone.slice(0, 5)}****${phone.slice(-2)}`;

export interface HttpSmsConfig {
  url: string;
  /** Valeur de l'en-tête Authorization, fournie par l'exploitant (jamais dans le dépôt). */
  authorization?: string | undefined;
  sender?: string | undefined;
  /** Noms des champs du JSON attendu par la passerelle. */
  fields?: { to: string; text: string; sender: string } | undefined;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Passerelle SMS HTTP générique : POST JSON {to, text, sender}. Les noms de champs, l'adresse et le jeton se règlent
 * par configuration, ce qui couvre la plupart des opérateurs et agrégateurs sans réécrire de code. Réessaie les
 * erreurs réseau et 5xx (pas les 4xx : un refus de la passerelle n'ira pas mieux au deuxième essai).
 */
export function httpSmsProvider(
  config: HttpSmsConfig,
  log?: (m: string) => void,
): NotificationProvider {
  const f = config.fields ?? { to: "to", text: "text", sender: "sender" };
  const retries = config.retries ?? 2;
  return {
    async send(message) {
      const to = normalizePhone(message.to);
      let last = "";
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const res = await fetch(config.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(config.authorization ? { authorization: config.authorization } : {}),
            },
            body: JSON.stringify({
              [f.to]: to,
              [f.text]: message.text,
              ...(config.sender ? { [f.sender]: config.sender } : {}),
            }),
            signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
          });
          if (res.ok) {
            log?.(`SMS accepté pour ${maskPhone(to)}`);
            return;
          }
          last = `la passerelle a répondu ${res.status}`;
          if (res.status < 500) break;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
        if (attempt < retries) await wait((config.backoffMs ?? 500) * 2 ** attempt);
      }
      throw new Error(`SMS non envoyé à ${maskPhone(to)} : ${last}`);
    },
  };
}

/** Fournisseur choisi par l'environnement ; sans configuration, les messages restent dans le journal. */
export function providerFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): NotificationProvider {
  if (!env.SMS_GATEWAY_URL) {
    return {
      send: async (m) =>
        void log(`rappel prêt à l'envoi (aucune passerelle configurée) : ${m.text}`),
    };
  }
  return httpSmsProvider(
    {
      url: env.SMS_GATEWAY_URL,
      authorization: env.SMS_GATEWAY_AUTHORIZATION,
      sender: env.SMS_SENDER,
      fields:
        env.SMS_FIELD_TO && env.SMS_FIELD_TEXT
          ? {
              to: env.SMS_FIELD_TO,
              text: env.SMS_FIELD_TEXT,
              sender: env.SMS_FIELD_SENDER ?? "sender",
            }
          : undefined,
    },
    log,
  );
}
