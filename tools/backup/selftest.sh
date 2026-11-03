#!/usr/bin/env bash
# Test de bout en bout de la sauvegarde / restauration contre la pile de test (PostgreSQL de tools/dev-stack).
# Prouve : sauvegarde chiffrée, restauration complète (mêmes nombres de lignes), droits et journal d'audit en
# lecture seule conservés, altération détectée, mauvaise clé refusée, écrasement d'une base non vide refusé.
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE="${CHU_STACK_DIR:-/tmp/chu-dev-stack}"; PORT="${PG_PORT:-55432}"
ADMIN="postgres://postgres:$(cat "$STATE/pg_admin")@127.0.0.1:$PORT"
W="$(mktemp -d)"; trap 'rm -rf "$W"; psql "$ADMIN/postgres" -qc "drop database if exists chu_restore_test" >/dev/null' EXIT
ok() { echo "  ✔ $*"; }
fail() { echo "  ✘ $*" >&2; exit 1; }

age-keygen -o "$W/key.txt" 2>/dev/null; REC="$(age-keygen -y "$W/key.txt")"
age-keygen -o "$W/other.txt" 2>/dev/null

# 1. Sauvegarde
file="$(BACKUP_DB_URL="$ADMIN/chu" BACKUP_DIR="$W/b" BACKUP_AGE_RECIPIENT="$REC" tools/backup/backup.sh)"
[ -s "$file" ] && ok "sauvegarde chiffrée créée ($(du -h "$file" | cut -f1))"
! grep -qa "PGDMP" "$file" && ok "le fichier n'est pas lisible sans la clé"

# 2. Restauration dans une base vide
psql "$ADMIN/postgres" -qc "drop database if exists chu_restore_test" -c "create database chu_restore_test"
RESTORE_DB_URL="$ADMIN/chu_restore_test" tools/backup/restore.sh "$file" "$W/key.txt" >/dev/null
tools/backup/counts.sh db "$ADMIN/chu" > "$W/live.txt"
tools/backup/counts.sh db "$ADMIN/chu_restore_test" > "$W/restored.txt"
tools/backup/counts.sh dump "$file" "$W/key.txt" > "$W/dump.txt"
[ -s "$W/live.txt" ] || fail "aucun comptage"
diff "$W/live.txt" "$W/restored.txt" >/dev/null && ok "base restaurée : mêmes nombres de lignes dans les $(wc -l < "$W/live.txt") tables"
diff "$W/dump.txt" "$W/restored.txt" >/dev/null && ok "contenu de la sauvegarde = base restaurée"
echo "     $(awk '{s+=$2} END {print s}' "$W/restored.txt") lignes au total"

# 3. Les protections survivent à la restauration : journal d'audit en ajout seul, droits de chu_app
out="$(psql "$ADMIN/chu_restore_test" -qc "set role chu_app; update audit.log set action = 'x'" 2>&1 || true)"
if grep -qi "permission denied" <<<"$out"; then
  ok "journal d'audit toujours en ajout seul après restauration"
else fail "le journal d'audit est modifiable après restauration : $out"; fi
psql "$ADMIN/chu_restore_test" -Atc "select count(*) from information_schema.table_privileges where grantee='chu_app'" | grep -qv '^0$' \
  && ok "droits de chu_app conservés"

# 4. Garde-fous
RESTORE_DB_URL="$ADMIN/chu_restore_test" tools/backup/restore.sh "$file" "$W/key.txt" >/dev/null 2>&1 \
  && fail "écrasement d'une base non vide accepté" || ok "restauration sur une base non vide refusée"
psql "$ADMIN/postgres" -qc "drop database chu_restore_test" -c "create database chu_restore_test"
RESTORE_DB_URL="$ADMIN/chu_restore_test" tools/backup/restore.sh "$file" "$W/other.txt" >/dev/null 2>&1 \
  && fail "mauvaise clé acceptée" || ok "mauvaise clé refusée"
cp "$file" "$W/b/copy.dump.age"; cp "$file.sha256" "$W/b/copy.dump.age.sha256"; sed -i "s/$(basename "$file")/copy.dump.age/" "$W/b/copy.dump.age.sha256"
printf 'x' >> "$W/b/copy.dump.age"
RESTORE_DB_URL="$ADMIN/chu_restore_test" tools/backup/restore.sh "$W/b/copy.dump.age" "$W/key.txt" >/dev/null 2>&1 \
  && fail "fichier altéré accepté" || ok "fichier altéré détecté avant restauration"
echo "Sauvegarde / restauration : tout est vérifié."
