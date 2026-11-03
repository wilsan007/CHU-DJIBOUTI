#!/usr/bin/env bash
# Exercice de restauration sur un serveur NEUF (conteneur PostgreSQL vierge, comme une autre machine) :
# rôles recréés, base restaurée depuis la sauvegarde chiffrée, contenu comparé à la sauvegarde, migrations (aucune en
# attente attendue), API démarrée sur la base restaurée. Mesure la durée (RTO réel de l'exercice).
#   Usage : drill.sh <sauvegarde.dump.age> <clé-privée-age>
# Variables : PG_IMAGE, DRILL_PORT (55433), DRILL_ADMIN_PASSWORD, CHU_MIGRATOR_PASSWORD, CHU_APP_PASSWORD (mots de passe des rôles).
set -euo pipefail
cd "$(dirname "$0")/../.."
file="${1:?sauvegarde}"; key="${2:?clé privée}"
PORT="${DRILL_PORT:-55433}"; IMG="${PG_IMAGE:-postgres:16}"; ADM="${DRILL_ADMIN_PASSWORD:-drill-$RANDOM$RANDOM}"
: "${CHU_MIGRATOR_PASSWORD:?}"; : "${CHU_APP_PASSWORD:?}"
start=$(date +%s)
trap 'docker rm -f chu-pg-drill >/dev/null 2>&1; [ -n "${API:-}" ] && kill "$API" 2>/dev/null; fuser -k 3102/tcp >/dev/null 2>&1; true' EXIT
ok() { echo "  ✔ $*"; }
docker rm -f chu-pg-drill >/dev/null 2>&1 || true
docker run -d --name chu-pg-drill -e POSTGRES_PASSWORD="$ADM" -p "127.0.0.1:$PORT:5432" "$IMG" >/dev/null
until docker exec chu-pg-drill pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 2
ADMIN="postgres://postgres:$ADM@127.0.0.1:$PORT"
DATABASE_ADMIN_URL="$ADMIN/postgres" CHU_MIGRATOR_PASSWORD="$CHU_MIGRATOR_PASSWORD" CHU_APP_PASSWORD="$CHU_APP_PASSWORD" pnpm --filter @chu/api bootstrap >/dev/null
ok "serveur neuf : rôles et base vide créés"
RESTORE_DB_URL="$ADMIN/chu" tools/backup/restore.sh "$file" "$key" >/dev/null
ok "sauvegarde restaurée ($(( $(date +%s) - start )) s depuis le début)"
diff <(tools/backup/counts.sh dump "$file" "$key") <(tools/backup/counts.sh db "$ADMIN/chu") >/dev/null && ok "contenu identique à la sauvegarde, table par table"
out="$(DATABASE_MIGRATOR_URL="postgres://chu_migrator:$CHU_MIGRATOR_PASSWORD@127.0.0.1:$PORT/chu" pnpm --filter @chu/api migrate 2>&1 || true)"
ok "migrations : $(tail -1 <<<"$out")"
DATABASE_URL="postgres://chu_app:$CHU_APP_PASSWORD@127.0.0.1:$PORT/chu" AUTH_ISSUER=http://localhost:1/realms/x AUTH_AUDIENCE=chu-api \
  AUTH_JWKS_URL=http://localhost:1/jwks PORT=3102 pnpm --filter @chu/api start > /tmp/drill-api.log 2>&1 &
API=$!
for _ in $(seq 30); do curl -fs localhost:3102/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs localhost:3102/health | grep -q '"db":"ok"' && ok "API démarrée sur la base restaurée (/health : db ok)"
echo "Exercice terminé en $(( $(date +%s) - start )) s."
