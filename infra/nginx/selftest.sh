#!/usr/bin/env bash
# Contrôle du point d'entrée HTTPS de production : nginx réel dans Docker, certificat de test auto-signé, API de la pile
# de test derrière. Prérequis : pile lancée (tools/dev-stack/stack.sh start) et portail construit (pnpm --filter @chu/portal build).
set -euo pipefail
cd "$(dirname "$0")/../.."
W="$(mktemp -d)"; trap 'docker rm -f chu-nginx-test >/dev/null 2>&1; rm -rf "$W"' EXIT
ok() { echo "  ✔ $*"; }; fail() { echo "  ✘ $*" >&2; exit 1; }
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" \
  -keyout "$W/privkey.pem" -out "$W/fullchain.pem" 2>/dev/null
cp infra/nginx/nginx.prod.conf.template "$W/default.conf.template"
IMG="${NGINX_IMAGE:-mirror.gcr.io/nginx:1.27}"
docker run -d --name chu-nginx-test --add-host=host.docker.internal:host-gateway -p 127.0.0.1:8443:443 -p 127.0.0.1:8088:80 \
  -e SERVER_NAME=localhost -e API_UPSTREAM=host.docker.internal:3100 -e IDP_UPSTREAM=host.docker.internal:8081 -e CSP_CONNECT="'self'" \
  -v "$W/default.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  -v "$W/fullchain.pem:/etc/nginx/tls/fullchain.pem:ro" -v "$W/privkey.pem:/etc/nginx/tls/privkey.pem:ro" \
  -v "$PWD/apps/portal/dist:/usr/share/nginx/html:ro" "$IMG" >/dev/null
for _ in $(seq 20); do curl -sk -o /dev/null https://localhost:8443/ && break; sleep 0.5; done
docker exec chu-nginx-test nginx -t 2>&1 | grep -q "successful" && ok "configuration valide (nginx -t)"

C="curl -sk --max-time 10"
[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost:8088/x?y=1)" = "301 https://localhost/x?y=1" ] && ok "HTTP redirigé vers HTTPS"
H="$($C -D - -o /dev/null https://localhost:8443/)"
for h in "strict-transport-security" "x-content-type-options: nosniff" "x-frame-options: DENY" "content-security-policy: default-src 'none'" "referrer-policy"; do
  grep -qi "$h" <<<"$H" || fail "en-tête manquant sur / : $h"; done; ok "en-têtes de sécurité présents sur la page"
grep -qi "server: nginx/" <<<"$H" && fail "version de nginx divulguée"; ok "version de nginx masquée"
grep -qi "cache-control: no-cache" <<<"$H" && ok "page d'entrée jamais mise en cache"
asset="$(ls apps/portal/dist/assets | grep '\.js$' | head -1)"
A="$($C -D - -o /dev/null "https://localhost:8443/assets/$asset")"
grep -qi "cache-control: max-age=315360000" <<<"$A" && ok "fichiers à empreinte mis en cache longtemps"
grep -qi "x-content-type-options: nosniff" <<<"$A" && grep -qi "strict-transport" <<<"$A" || fail "en-têtes de sécurité perdus sur /assets"; ok "en-têtes de sécurité conservés sur les fichiers statiques"
[ "$($C -o /dev/null -w '%{http_code}' https://localhost:8443/une/route/du/portail)" = "200" ] && ok "routes du portail servies (repli sur index.html)"
[ "$($C -o /dev/null -w '%{http_code}' https://localhost:8443/api/me)" = "401" ] && ok "API atteinte à travers le proxy (401 sans jeton)"
[ "$($C -o /dev/null -w '%{http_code}' https://localhost:8443/metrics)" = "404" ] && ok "/metrics non exposé"
[ "$($C -o /dev/null -w '%{http_code}' https://localhost:8443/health)" = "200" ] && ok "/health joignable"
curl -sk --tls-max 1.1 -o /dev/null https://localhost:8443/ 2>/dev/null && fail "TLS 1.1 accepté" || ok "TLS 1.1 refusé"
curl -sk --tlsv1.3 -o /dev/null https://localhost:8443/ && ok "TLS 1.3 accepté"
head -c 19000000 /dev/zero | tr '\0' 'a' > "$W/big.json"
code="$($C -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @"$W/big.json" https://localhost:8443/api/me)"
[ "$code" = "413" ] && ok "corps trop gros refusé (413)" || fail "corps de 19 Mo : code $code au lieu de 413"
echo "Point d'entrée HTTPS : tout est vérifié."
