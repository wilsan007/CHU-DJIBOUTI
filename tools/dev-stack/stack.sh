#!/usr/bin/env bash
# Pile de développement locale pour les tests de bout en bout : PostgreSQL (Docker), Keycloak (archive), API, portail.
# Mode « même origine » (PUBLIC_URL=https://hote:port) : Keycloak est servi sous /auth du portail (comme en production derrière
# Nginx) ; nécessaire quand le navigateur n'est pas sur la même machine (GitHub Codespaces, serveur de recette).
# Usage : KEYCLOAK_HOME=/chemin/keycloak-26.8.1 tools/dev-stack/stack.sh start|stop|env
# Les mots de passe sont tirés au hasard à chaque démarrage et écrits dans $STACK_DIR (hors dépôt).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_DIR="${STACK_DIR:-/tmp/chu-dev-stack}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"
PG_PORT="${PG_PORT:-55432}"
API_PORT="${API_PORT:-3100}"
KC_PORT="${KC_PORT:-8081}"
PUBLIC_URL="${PUBLIC_URL:-}"
KC_PATH=""; KC_EXTRA=(); ISSUER_BASE="http://localhost:$KC_PORT"; PORTAL_AUTH=""
if [ -n "$PUBLIC_URL" ]; then
  KC_PATH="/auth"; ISSUER_BASE="$PUBLIC_URL/auth"; PORTAL_AUTH="/auth/realms/chu"
  KC_EXTRA=(--http-relative-path=/auth "--hostname=$PUBLIC_URL/auth" --proxy-headers=xforwarded)
fi
rand() { head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Déclare l'adresse publique comme adresse de retour du client « chu-web » (le domaine importé ne connaît que localhost).
allow_public_redirect() {
  local dev="$1" tk cid
  tk="$(curl -s -X POST "http://localhost:$KC_PORT$KC_PATH/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli -d username=admin -d "password=adm-$dev" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
  cid="$(curl -s -H "authorization: Bearer $tk" "http://localhost:$KC_PORT$KC_PATH/admin/realms/chu/clients?clientId=chu-web" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
  curl -s -H "authorization: Bearer $tk" "http://localhost:$KC_PORT$KC_PATH/admin/realms/chu/clients/$cid" \
    | PU="$PUBLIC_URL" python3 -c 'import sys,json,os;c=json.load(sys.stdin);u=os.environ["PU"];c["redirectUris"]+=[u+"/*"];c["webOrigins"]+=[u];print(json.dumps(c))' > "$STACK_DIR/client.json"
  curl -s -o /dev/null -X PUT -H "authorization: Bearer $tk" -H "content-type: application/json" -d @"$STACK_DIR/client.json" "http://localhost:$KC_PORT$KC_PATH/admin/realms/chu/clients/$cid"
}

start() {
  : "${KEYCLOAK_HOME:?KEYCLOAK_HOME doit pointer vers keycloak-26.x (archive décompressée)}"
  mkdir -p "$STACK_DIR"
  local admin dev kcadmin bridge
  admin="$(rand)"; dev="Dev-$(rand)-Aa1"; kcadmin="adm-$(rand)"; bridge="br-$(rand)"
  printf '%s' "$admin" > "$STACK_DIR/pg_admin"; printf '%s' "$dev" > "$STACK_DIR/dev_password"; printf '%s' "$kcadmin" > "$STACK_DIR/admin_client_secret"; printf '%s' "$bridge" > "$STACK_DIR/lab_bridge_secret"

  docker rm -f chu-pg >/dev/null 2>&1 || true
  docker run -d --name chu-pg -e POSTGRES_PASSWORD="$admin" -p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE" >/dev/null
  until docker exec chu-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  sleep 2

  export DATABASE_ADMIN_URL="postgres://postgres:$admin@127.0.0.1:$PG_PORT/postgres" CHU_MIGRATOR_PASSWORD="m$admin" CHU_APP_PASSWORD="a$admin"
  (cd "$ROOT" && pnpm --filter @chu/api bootstrap >/dev/null && DATABASE_MIGRATOR_URL="postgres://chu_migrator:m$admin@127.0.0.1:$PG_PORT/chu" pnpm --filter @chu/api migrate >/dev/null)

  rm -rf "$KEYCLOAK_HOME/data/h2" "$KEYCLOAK_HOME/data/transaction-logs"
  mkdir -p "$KEYCLOAK_HOME/data/import"; cp "$ROOT/infra/keycloak/realm-chu.json" "$KEYCLOAK_HOME/data/import/"
  # `exec` remplace le sous-shell par le service : aucun processus intermédiaire ne garde la sortie du script ouverte.
  ( cd "$KEYCLOAK_HOME" && CHU_DEV_USER_PASSWORD="$dev" CHU_ADMIN_CLIENT_SECRET="$kcadmin" CHU_LAB_BRIDGE_SECRET="$bridge" KC_BOOTSTRAP_ADMIN_USERNAME=admin KC_BOOTSTRAP_ADMIN_PASSWORD="adm-$dev" \
    exec setsid nohup bin/kc.sh start-dev --import-realm --http-port="$KC_PORT" --http-host=0.0.0.0 "${KC_EXTRA[@]}" > "$STACK_DIR/keycloak.log" 2>&1 < /dev/null ) &
  until curl -fs "http://localhost:$KC_PORT$KC_PATH/realms/chu" >/dev/null 2>&1; do sleep 2; done
  if [ -n "$PUBLIC_URL" ]; then allow_public_redirect "$dev"; fi

  ( cd "$ROOT" && DATABASE_URL="postgres://chu_app:a$admin@127.0.0.1:$PG_PORT/chu" AUTH_ISSUER="$ISSUER_BASE/realms/chu" AUTH_AUDIENCE=chu-api \
    AUTH_JWKS_URL="http://localhost:$KC_PORT$KC_PATH/realms/chu/protocol/openid-connect/certs" PORT="$API_PORT" \
    KEYCLOAK_ADMIN_URL="http://localhost:$KC_PORT$KC_PATH" KEYCLOAK_ADMIN_CLIENT_SECRET="$kcadmin" \
    exec setsid nohup pnpm --filter @chu/api start > "$STACK_DIR/api.log" 2>&1 < /dev/null ) &
  ( cd "$ROOT/apps/portal" && API_URL="http://localhost:$API_PORT" KC_URL="http://localhost:$KC_PORT" VITE_OIDC_AUTHORITY="$PORTAL_AUTH" exec setsid nohup pnpm dev > "$STACK_DIR/portal.log" 2>&1 < /dev/null ) &
  until curl -fs "http://localhost:$API_PORT/health" >/dev/null 2>&1; do sleep 1; done
  until curl -fs "http://localhost:8080/" >/dev/null 2>&1; do sleep 1; done
  echo "Pile prête. Mot de passe des comptes dev-* : $STACK_DIR/dev_password"
}

stop() {
  pkill -x node 2>/dev/null || true
  pkill -x java 2>/dev/null || true
  docker rm -f chu-pg >/dev/null 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  env) echo "export CHU_DEV_USER_PASSWORD=\$(cat $STACK_DIR/dev_password)" ;;
  *) echo "Usage : stack.sh start|stop|env" >&2; exit 1 ;;
esac
