import { accessToken } from "./auth.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* Attente : le nombre d'appels en cours alimente la barre de progression (affichée si l'attente dépasse un instant). */
let pendingCount = 0;
const pendingListeners = new Set<() => void>();
const bump = (delta: number): void => {
  pendingCount += delta;
  pendingListeners.forEach((l) => l());
};
export const subscribePending = (cb: () => void): (() => void) => {
  pendingListeners.add(cb);
  return () => pendingListeners.delete(cb);
};
export const getPending = (): number => pendingCount;

/** Actions en cours : un second clic identique (double clic, doigt qui insiste) rejoint la même requête au lieu d'en créer une deuxième. */
const inflight = new Map<string, Promise<unknown>>();

/** Appel de l'API avec le jeton Keycloak. Les erreurs de l'API gardent leur code (ex. possible_duplicates). */
export function api<T>(
  path: string,
  options: { method?: string; body?: unknown; csv?: string } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  if (method === "GET") return call<T>(path, options);
  const key = `${method} ${path} ${JSON.stringify(options.body ?? options.csv ?? "")}`;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = call<T>(path, options).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; csv?: string },
): Promise<T> {
  bump(1);
  try {
    return await rawCall<T>(path, options);
  } finally {
    bump(-1);
  }
}

async function rawCall<T>(
  path: string,
  options: { method?: string; body?: unknown; csv?: string },
): Promise<T> {
  const token = await accessToken();
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token ?? ""}`,
      ...(options.csv !== undefined ? { "content-type": "text/csv" } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.csv !== undefined ? { body: options.csv } : {}),
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}

let currentMe: Me | null = null;
/** Mémorise le profil connecté (appelé une fois par l'application) : les écrans masquent ce que le rôle ne peut pas faire. */
export const rememberMe = (me: Me | null): void => {
  currentMe = me;
};
/** Le profil connecté a-t-il cette permission ? Évite d'afficher un bouton ou un bloc qui répondrait « interdit ». */
export const can = (permission: string): boolean =>
  currentMe?.permissions.includes(permission) ?? false;

export interface Me {
  id: string;
  name: string;
  roles: string[];
  permissions: string[];
}
