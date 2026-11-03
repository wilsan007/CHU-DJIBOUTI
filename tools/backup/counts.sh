#!/usr/bin/env bash
# Nombre de lignes par table, pour comparer deux bases (ou une base et une sauvegarde).
#   counts.sh db  <url>                 → lit la base
#   counts.sh dump <fichier.dump.age> <clé> → lit la sauvegarde, sans la restaurer
set -euo pipefail
case "$1" in
  db)
    psql "$2" -Atc "select format('select %L, count(*) from %I.%I;', schemaname||'.'||tablename, schemaname, tablename) from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1" \
      | psql "$2" -At | sed 's/|/ /' | sort ;;
  dump)
    age -d -i "$3" "$2" | pg_restore --data-only -f - \
      | awk '/^COPY /{t=$2; n=0; inb=1; next} inb && /^\\\.$/{print t, n; inb=0; next} inb{n++}' | sort ;;
  *) echo "usage: counts.sh db <url> | dump <fichier> <clé>" >&2; exit 1 ;;
esac
