#!/usr/bin/env bash
# Restauration à un instant précis (PITR) avec archivage continu des journaux (WAL), sur un PostgreSQL jetable.
# Scénario : sauvegarde de base, travail normal, instant T (200 lignes), suppression accidentelle de tout le contenu,
# puis retour à l'instant T. Prouve que l'archivage continu ramène la perte de données de 24 h à quelques secondes.
# Réglages à reproduire sur le vrai serveur : wal_level=replica, archive_mode=on, archive_command (voir infra/backup/README.md).
set -euo pipefail
IMG="${PG_IMAGE:-postgres:16}"
W="$(mktemp -d)"; chmod 777 "$W"; mkdir "$W/archive"; chmod 777 "$W/archive"
trap 'docker rm -f chu-pitr-src chu-pitr-new >/dev/null 2>&1; docker run --rm -v "$W:/w" "$IMG" rm -rf /w/restored /w/archive >/dev/null 2>&1; rm -rf "$W"' EXIT
ok() { echo "  ✔ $*"; }
q() { docker exec -u postgres "$1" psql -U postgres -Atc "$2"; }
docker run -d --name chu-pitr-src -e POSTGRES_PASSWORD=x -v "$W/archive:/archive" "$IMG" \
  -c wal_level=replica -c archive_mode=on -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f" -c archive_timeout=5 >/dev/null
until docker exec chu-pitr-src pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
q chu-pitr-src "create table t (n int primary key)" >/dev/null
q chu-pitr-src "insert into t select generate_series(1,100)" >/dev/null
docker exec -u postgres chu-pitr-src pg_basebackup -U postgres -D /archive/base -Fp -X stream -c fast >/dev/null
ok "sauvegarde de base prise ($(q chu-pitr-src 'select count(*) from t') lignes)"
q chu-pitr-src "insert into t select generate_series(101,200)" >/dev/null
sleep 2
T="$(q chu-pitr-src "select to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US')")"
sleep 2
q chu-pitr-src "delete from t" >/dev/null   # l'accident
q chu-pitr-src "select pg_switch_wal()" >/dev/null
for _ in $(seq 20); do [ "$(ls "$W/archive" | grep -vc base)" -ge 3 ] && break; sleep 1; done
[ "$(q chu-pitr-src 'select count(*) from t')" = "0" ] && ok "accident simulé : table vidée à $T (UTC)"
ok "journaux archivés : $(ls "$W/archive" | grep -vc base) fichiers"
docker stop chu-pitr-src >/dev/null
# Restauration : la sauvegarde de base devient le répertoire de données ; les journaux sont rejoués jusqu'à T.
mv "$W/archive/base" "$W/restored"
touch "$W/restored/recovery.signal"
cat >> "$W/restored/postgresql.auto.conf" <<CONF
restore_command = 'cp /archive/%f %p'
recovery_target_time = '$T+00'
recovery_target_action = 'promote'
CONF
docker run --rm -v "$W:/w" "$IMG" chown -R 999:999 /w/restored /w/archive
docker run -d --name chu-pitr-new -e POSTGRES_PASSWORD=x -v "$W/restored:/var/lib/postgresql/data" -v "$W/archive:/archive" "$IMG" >/dev/null
for _ in $(seq 40); do [ "$(q chu-pitr-new 'select pg_is_in_recovery()' 2>/dev/null)" = "f" ] && break; sleep 1; done
n="$(q chu-pitr-new 'select count(*) from t')"
[ "$n" = "200" ] && ok "retour à l'instant T : $n lignes retrouvées (l'accident est annulé)" || { echo "  ✘ $n lignes au lieu de 200" >&2; exit 1; }
echo "PITR : vérifié."
