#!/usr/bin/env bash
# Démarre toute l'application dans un GitHub Codespace (recette en ligne, DONNÉES FICTIVES SEULEMENT) :
# PostgreSQL (Docker), Keycloak sous /auth, API, portail, catalogues d'exemple. L'adresse publique du Codespace est déduite
# de ses variables d'environnement ; le port 8080 reste PRIVÉ (visible du seul propriétaire) tant que vous ne le changez pas.
set -euo pipefail
cd "$(dirname "$0")/../.."
KC_VERSION="${KC_VERSION:-26.8.1}"
export KEYCLOAK_HOME="${KEYCLOAK_HOME:-$HOME/keycloak-$KC_VERSION}"
if [ ! -d "$KEYCLOAK_HOME" ]; then
  echo "Téléchargement de Keycloak $KC_VERSION…"
  curl -fsSL "https://github.com/keycloak/keycloak/releases/download/$KC_VERSION/keycloak-$KC_VERSION.tar.gz" | tar -xz -C "$HOME"
fi
if [ -n "${CODESPACE_NAME:-}" ]; then
  export PUBLIC_URL="https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  export PUBLIC_URL="${PUBLIC_URL:-http://localhost:8080}"
fi
echo "Adresse publique : $PUBLIC_URL"
tools/dev-stack/stack.sh stop >/dev/null 2>&1 || true
tools/dev-stack/stack.sh start
export CHU_DEV_USER_PASSWORD="$(cat "${STACK_DIR:-/tmp/chu-dev-stack}/dev_password")"
KEYCLOAK_URL="http://localhost:${KC_PORT:-8081}/auth" API_URL="http://localhost:${API_PORT:-3100}" node tools/dev-stack/demo-data.mjs
cat <<MSG

================================================================================
  CHU DE DJIBOUTI : RECETTE EN LIGNE (données fictives)
  Ouvrir : $PUBLIC_URL        (port 8080 de l'onglet « Ports »)
  Comptes : dev-reception, dev-cashier, dev-doctor, dev-nurse, dev-lab, dev-biologist, dev-pharmacy,
            dev-storekeeper, dev-imaging, dev-hr, dev-direction, dev-admin
  Mot de passe commun : $CHU_DEV_USER_PASSWORD   (fichier ${STACK_DIR:-/tmp/chu-dev-stack}/dev_password)
  Rappel : aucune donnée réelle de patient ici.
================================================================================
MSG
