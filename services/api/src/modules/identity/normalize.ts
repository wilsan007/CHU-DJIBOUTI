/**
 * Normalisation des noms pour la recherche et la détection de doublons.
 * Latin : minuscules, sans accents. Arabe : sans voyelles brèves ni allongement, formes de l'alif
 * et du ya unifiées. Les mots sont triés : « Dirir Fatouma » et « Fatouma Dirir » donnent le même texte.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(ARABIC_MARKS, "")
    .normalize("NFC")
    .replace(/[أإآٱ]/g, "ا") // أ إ آ ٱ -> ا
    .replace(/ى/g, "ي") // ى -> ي
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function nameTokens(...parts: (string | null | undefined)[]): string[] {
  return normalizeText(parts.filter(Boolean).join(" "))
    .split(" ")
    .filter((t) => t !== "");
}

/** Texte stocké dans `name_norm` : mots normalisés, triés, séparés par une espace. */
export function normalizeName(...parts: (string | null | undefined)[]): string {
  return nameTokens(...parts)
    .sort()
    .join(" ");
}

export function phoneDigits(phone: string): string {
  return phone.replace(/\D+/g, "");
}
