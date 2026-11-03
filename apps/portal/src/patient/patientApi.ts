import { ApiError } from "../api.ts";

/** Session du patient : jeton de courte durée gardé pour l'onglet seulement (jamais dans un stockage durable). */
const KEY = "patient-token";
export const getToken = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const setToken = (t: string | null): void => {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    // stockage indisponible : la session ne survivra pas au rechargement
  }
};

export async function papi<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.auth !== false && token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? res.statusText, undefined);
  }
  return data as T;
}
