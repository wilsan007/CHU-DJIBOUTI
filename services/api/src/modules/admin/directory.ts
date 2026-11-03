import { DomainError } from "../../errors.ts";
import type { Role } from "../../auth/permissions.ts";

/** Annuaire des comptes (Keycloak). Le registre local reste la référence pour couper un accès immédiatement. */
export interface UserDirectory {
  createUser(input: {
    username: string;
    email: string;
    role: Role;
    temporaryPassword: string;
  }): Promise<{ id: string }>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Un seul rôle par compte par défaut (plan F14-1) : l'ancien rôle est retiré. */
  setRole(id: string, role: Role, allRoles: readonly Role[]): Promise<void>;
}

export interface KeycloakAdminOptions {
  /** Racine de Keycloak, ex. http://keycloak:8080 */
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

/** Implémentation par l'API d'administration de Keycloak (compte de service limité à la gestion des utilisateurs). */
export function keycloakDirectory(o: KeycloakAdminOptions): UserDirectory {
  let cached: { token: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.until > Date.now() + 10_000) return cached.token;
    const res = await fetch(`${o.baseUrl}/realms/${o.realm}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: o.clientId,
        client_secret: o.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Keycloak : jeton refusé (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return cached.token;
  };
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(`${o.baseUrl}/admin/realms/${o.realm}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 404 && path.startsWith("/users/"))
      throw new DomainError(
        "account_not_in_directory",
        "Ce compte n'existe plus dans l'annuaire de connexion (supprimé directement dans Keycloak ?). Désactivez-le ici pour couper l'accès.",
        409,
      );
    if (!res.ok) {
      // Détail technique pour le journal du service ; message clair pour l'utilisateur.
      console.error(`Keycloak ${init.method ?? "GET"} ${path} : ${res.status}`);
      throw new DomainError(
        "directory_error",
        "L'annuaire des comptes a refusé l'opération. Réessayez ; si cela continue, prévenez la DSI.",
        502,
      );
    }
    return res;
  };
  const realmRole = async (name: string) =>
    (await (await admin(`/roles/${encodeURIComponent(name)}`)).json()) as {
      id: string;
      name: string;
    };

  return {
    async createUser(input) {
      const res = await admin("/users", {
        method: "POST",
        body: JSON.stringify({
          username: input.username,
          email: input.email,
          enabled: true,
          emailVerified: true,
          credentials: [{ type: "password", value: input.temporaryPassword, temporary: true }],
        }),
      });
      const id = res.headers.get("location")?.split("/").pop();
      if (!id) throw new Error("Keycloak : identifiant du compte créé introuvable");
      await admin(`/users/${id}/role-mappings/realm`, {
        method: "POST",
        body: JSON.stringify([await realmRole(input.role)]),
      });
      return { id };
    },
    async setEnabled(id, enabled) {
      const current = (await (await admin(`/users/${id}`)).json()) as Record<string, unknown>;
      await admin(`/users/${id}`, { method: "PUT", body: JSON.stringify({ ...current, enabled }) });
      if (!enabled) await admin(`/users/${id}/logout`, { method: "POST" });
    },
    async setRole(id, role, allRoles) {
      const current = (await (await admin(`/users/${id}/role-mappings/realm`)).json()) as {
        id: string;
        name: string;
      }[];
      const ours = current.filter(
        (r) => (allRoles as readonly string[]).includes(r.name) && r.name !== role,
      );
      if (ours.length)
        await admin(`/users/${id}/role-mappings/realm`, {
          method: "DELETE",
          body: JSON.stringify(ours),
        });
      if (!current.some((r) => r.name === role))
        await admin(`/users/${id}/role-mappings/realm`, {
          method: "POST",
          body: JSON.stringify([await realmRole(role)]),
        });
    },
  };
}
