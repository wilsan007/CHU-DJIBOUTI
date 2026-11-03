#!/usr/bin/env bash
# Essai complet du point d'entrée : Keycloak sous /auth du même nom, API et portail derrière nginx en HTTPS.
# Lance un SECOND Keycloak (port 8082, copie de $KEYCLOAK_HOME), une seconde API (3101) et nginx (8443), puis rejoue
# apps/portal/e2e/https-auth.mjs. Prérequis : la pile de test tourne (tools/dev-stack/stack.sh start).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${KEYCLOAK_HOME:?KEYCLOAK_HOME (Keycloak 26 dézippé) est obligatoire}"
STATE="${CHU_STACK_DIR:-/tmp/chu-dev-stack}"; P="$(cat "$STATE/pg_admin")"; D="$(cat "$STATE/dev_password")"
W="$(mktemp -d)"
cleanup() { docker rm -f chu-nginx-test >/dev/null 2>&1 || true; pkill -f "http-port=8082" 2>/dev/null || true; fuser -k 3101/tcp >/dev/null 2>&1 || true; rm -rf "$W"; pnpm --filter @chu/portal build >/dev/null 2>&1 || true; }
trap cleanup EXIT
cp -r "$KEYCLOAK_HOME" "$W/kc"; rm -rf "$W/kc/data/h2" "$W/kc/data/transaction-logs"; mkdir -p "$W/kc/data/import"; cp infra/keycloak/realm-chu.json "$W/kc/data/import/"
( cd "$W/kc" && CHU_DEV_USER_PASSWORD="$D" CHU_ADMIN_CLIENT_SECRET=essai CHU_LAB_BRIDGE_SECRET=essai KC_BOOTSTRAP_ADMIN_USERNAME=admin KC_BOOTSTRAP_ADMIN_PASSWORD="adm-$D" \
  setsid nohup bin/kc.sh start-dev --import-realm --http-port=8082 --http-host=0.0.0.0 --http-relative-path=/auth \
  --hostname=https://localhost:8443/auth --proxy-headers=xforwarded > "$W/kc.log" 2>&1 < /dev/null & )
until curl -fs http://localhost:8082/auth/realms/chu >/dev/null 2>&1; do sleep 2; done
TK="$(curl -s -X POST http://localhost:8082/auth/realms/master/protocol/openid-connect/token -d grant_type=password -d client_id=admin-cli -d username=admin -d "password=adm-$D" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
CID="$(curl -s -H "authorization: Bearer $TK" "http://localhost:8082/auth/admin/realms/chu/clients?clientId=chu-web" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
curl -s -H "authorization: Bearer $TK" "http://localhost:8082/auth/admin/realms/chu/clients/$CID" \
  | python3 -c 'import sys,json;c=json.load(sys.stdin);c["redirectUris"]+=["https://localhost:8443/*"];c["webOrigins"]+=["https://localhost:8443"];print(json.dumps(c))' > "$W/client.json"
curl -s -o /dev/null -X PUT -H "authorization: Bearer $TK" -H "content-type: application/json" -d @"$W/client.json" "http://localhost:8082/auth/admin/realms/chu/clients/$CID"
DATABASE_URL="postgres://chu_app:a$P@127.0.0.1:55432/chu" AUTH_ISSUER="https://localhost:8443/auth/realms/chu" AUTH_AUDIENCE=chu-api \
  AUTH_JWKS_URL="http://localhost:8082/auth/realms/chu/protocol/openid-connect/certs" PORT=3101 pnpm --filter @chu/api start > "$W/api.log" 2>&1 &
API2=$!
until curl -fs localhost:3101/health >/dev/null 2>&1; do sleep 1; done
VITE_OIDC_AUTHORITY=https://localhost:8443/auth/realms/chu pnpm --filter @chu/portal build >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" -keyout "$W/privkey.pem" -out "$W/fullchain.pem" 2>/dev/null
cp infra/nginx/nginx.prod.conf.template "$W/default.conf.template"
docker rm -f chu-nginx-test >/dev/null 2>&1 || true
docker run -d --name chu-nginx-test --add-host=host.docker.internal:host-gateway -p 127.0.0.1:8443:443 \
  -e SERVER_NAME=localhost -e API_UPSTREAM=host.docker.internal:3101 -e IDP_UPSTREAM=host.docker.internal:8082 -e CSP_CONNECT="'self'" \
  -v "$W/default.conf.template:/etc/nginx/templates/default.conf.template:ro" -v "$W/fullchain.pem:/etc/nginx/tls/fullchain.pem:ro" \
  -v "$W/privkey.pem:/etc/nginx/tls/privkey.pem:ro" -v "$PWD/apps/portal/dist:/usr/share/nginx/html:ro" "${NGINX_IMAGE:-mirror.gcr.io/nginx:1.27}" >/dev/null
sleep 3
CHU_DEV_USER_PASSWORD="$D" node apps/portal/e2e/https-auth.mjs
# Les tentatives de connexion sont freinées ; le reste (pages, polices) ne l'est pas.
codes="$(for i in $(seq 60); do curl -sk -o /dev/null -w '%{http_code}\n' -X POST "https://localhost:8443/auth/realms/chu/login-actions/authenticate?x=$i"; done | sort | uniq -c)"
grep -q 503 <<<"$codes" && echo "OK : tentatives de connexion répétées freinées (503)" || { echo "Pas de freinage : $codes" >&2; exit 1; }
[ "$(for i in $(seq 40); do curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/auth/realms/chu; done | grep -vc 200)" = "0" ] && echo "OK : pages de Keycloak non freinées"
