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

/** Appel de l'API avec le jeton Keycloak. Les erreurs de l'API gardent leur code (ex. possible_duplicates). */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; csv?: string } = {},
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

export interface Me {
  id: string;
  name: string;
  roles: string[];
  permissions: string[];
}
