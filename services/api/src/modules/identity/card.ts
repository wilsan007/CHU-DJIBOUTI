/**
 * Carte patient (histoire F1-6). Le QR code contient uniquement l'identifiant et une clé de contrôle :
 * aucune donnée médicale ni personnelle. Format : CHU1.<identifiant>.<clé à deux chiffres>.
 * La clé détecte une faute de saisie ou un code abîmé ; ce n'est pas un secret.
 */

const PREFIX = "CHU1";

export function checkDigits(identifier: string): string {
  let sum = 0;
  for (const ch of identifier) sum = (sum * 37 + ch.charCodeAt(0)) % 97;
  return String(97 - sum).padStart(2, "0");
}

export function cardPayload(identifier: string): string {
  return `${PREFIX}.${identifier}.${checkDigits(identifier)}`;
}

/** Renvoie l'identifiant contenu dans le code, ou null si le format ou la clé sont faux. */
export function parseCardPayload(payload: string): string | null {
  const match = /^CHU1\.([A-Z0-9-]{3,20})\.(\d{2})$/.exec(payload.trim());
  if (!match) return null;
  const [, identifier, key] = match;
  if (!identifier || checkDigits(identifier) !== key) return null;
  return identifier;
}
