/** Règles du contrôle de dépôt. Fonctions pures, testées dans test/rules.test.ts. */

const FORBIDDEN_PATHS: readonly RegExp[] = [
  /(^|\/)\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|jks)$/i,
  /\.(dump|bak)$/i,
  /\.sql\.gz$/i,
  /(^|\/)secrets\//,
];

const ALLOWED_PATHS: readonly RegExp[] = [/(^|\/)\.env\.example$/];

export function isForbiddenPath(path: string): boolean {
  if (ALLOWED_PATHS.some((r) => r.test(path))) return false;
  return FORBIDDEN_PATHS.some((r) => r.test(path));
}

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "clé privée",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: "jeton d'accès GitHub", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "clé d'accès AWS", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** Renvoie le nom du premier secret reconnu dans le texte, ou null. */
export function findSecret(text: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/** Lignes de `.env.example` qui portent une valeur (il ne doit contenir que des noms). */
export function envExampleValueLines(text: string): number[] {
  const bad: number[] = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const value = trimmed
      .slice(eq + 1)
      .replace(/\s+#.*$/, "")
      .trim();
    if (value !== "") bad.push(index + 1);
  });
  return bad;
}
