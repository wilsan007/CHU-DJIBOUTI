import { useSyncExternalStore } from "react";
import ar from "../../../packages/i18n/src/ar.json";
import fr from "../../../packages/i18n/src/fr.json";

export type Lang = "fr" | "ar";
const dictionaries: Record<Lang, Record<string, string>> = { fr, ar };
const listeners = new Set<() => void>();

function initial(): Lang {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "fr" || saved === "ar") return saved;
  } catch {
    // stockage indisponible : français par défaut
  }
  return "fr";
}
let current: Lang = initial();

function apply(): void {
  document.documentElement.lang = current;
  document.documentElement.dir = current === "ar" ? "rtl" : "ltr";
}
apply();

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem("lang", lang);
  } catch {
    // sans importance
  }
  apply();
  listeners.forEach((l) => l());
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Traduction avec paramètres {nom}. Une clé absente s'affiche telle quelle : l'oubli se voit tout de suite. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const text = dictionaries[current][key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/** Choisit le libellé de la langue courante (catalogues bilingues). */
export function label(fr: string, ar: string | null | undefined): string {
  return current === "ar" && ar ? ar : fr;
}
