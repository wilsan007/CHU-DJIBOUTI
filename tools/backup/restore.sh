#!/usr/bin/env bash
# Restauration d'une sauvegarde chiffrée dans une base VIDE (jamais par-dessus la base en service).
#   Usage : restore.sh <fichier.dump.age> <fichier-clé-privée-age>
#   Variables : RESTORE_DB_URL (base cible, vide, créée à l'avance ; rôles chu_migrator/chu_app déjà présents).
set -euo pipefail
file="${1:?fichier de sauvegarde}"; key="${2:?fichier de clé privée age}"
: "${RESTORE_DB_URL:?RESTORE_DB_URL est obligatoire}"
# 1. Intégrité du fichier AVANT toute opération.
(cd "$(dirname "$file")" && sha256sum --check --quiet "$(basename "$file").sha256") \
  || { echo "Somme de contrôle invalide : fichier altéré ou incomplet." >&2; exit 2; }
# 2. La cible doit être vide : on refuse d'écraser des données.
n="$(psql "$RESTORE_DB_URL" -Atc "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')")"
[ "$n" = "0" ] || { echo "Base cible non vide ($n tables) : restauration refusée." >&2; exit 3; }
# 3. Déchiffrement et restauration en une seule transaction logique (arrêt à la première erreur).
age -d -i "$key" "$file" | pg_restore --dbname="$RESTORE_DB_URL" --exit-on-error --no-comments
echo "Restauration terminée."
