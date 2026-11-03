import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

const authority = import.meta.env.VITE_OIDC_AUTHORITY ?? "http://localhost:8081/realms/chu";
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID ?? "chu-web";

/** Connexion unique par Keycloak (code d'autorisation avec PKCE). Le jeton reste en mémoire de la session du navigateur. */
export const manager = new UserManager({
  authority,
  client_id: clientId,
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  response_type: "code",
  scope: "openid",
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: false,
});

/** Termine la connexion au retour de Keycloak, ou renvoie la session en cours, ou lance la connexion. */
export async function ensureSignedIn(): Promise<User | null> {
  const url = new URL(window.location.href);
  if (url.searchParams.has("code") && url.searchParams.has("state")) {
    const user = await manager.signinRedirectCallback();
    window.history.replaceState({}, document.title, "/");
    return user;
  }
  const user = await manager.getUser();
  if (user && !user.expired) return user;
  await manager.signinRedirect();
  return null;
}

export async function accessToken(): Promise<string | null> {
  const user = await manager.getUser();
  if (!user || user.expired) {
    await manager.signinRedirect();
    return null;
  }
  return user.access_token;
}
