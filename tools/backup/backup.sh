#!/usr/bin/env bash
# Sauvegarde chiffrée de la base PostgreSQL du CHU.
#   Variables : BACKUP_DB_URL (compte propriétaire ou superutilisateur), BACKUP_DIR, BACKUP_AGE_RECIPIENT (clé PUBLIQUE age),
#               BACKUP_NAME (défaut chu), BACKUP_KEEP_DAYS (défaut 30 ; les 7 plus récentes sont toujours gardées).
# La clé privée n'est JAMAIS sur le serveur : un serveur compromis ne peut pas lire les anciennes sauvegardes.
set -euo pipefail
: "${BACKUP_DB_URL:?BACKUP_DB_URL est obligatoire}"
: "${BACKUP_DIR:?BACKUP_DIR est obligatoire}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT (clé publique age) est obligatoire}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
NAME="${BACKUP_NAME:-chu}" # « chu » pour la base de l'application, « keycloak » pour celle des comptes de connexion
umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/$NAME-$stamp.dump.age"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

# Format « custom » (compressé, restauration sélective possible), propriétaires et droits conservés.
pg_dump --format=custom --compress=6 --dbname="$BACKUP_DB_URL" | age -r "$BACKUP_AGE_RECIPIENT" -o "$tmp"
[ -s "$tmp" ] || { echo "Sauvegarde vide : abandon." >&2; exit 1; }
mv "$tmp" "$out"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
trap - EXIT

# Rotation : au-delà de KEEP_DAYS, mais on garde toujours les 7 plus récentes.
mapfile -t old < <(ls -1t "$BACKUP_DIR/$NAME"-*.dump.age 2>/dev/null | tail -n +8)
for f in "${old[@]}"; do
  if [ -n "$(find "$f" -mtime +"$KEEP_DAYS" -print 2>/dev/null)" ]; then rm -f "$f" "$f.sha256"; fi
done
echo "$out"
