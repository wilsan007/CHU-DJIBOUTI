#!/usr/bin/env bash
# Rejoue tous les scénarios navigateur contre la pile de test lancée par tools/dev-stack/stack.sh.
set -euo pipefail
cd "$(dirname "$0")/../../.."
STATE="${CHU_STACK_DIR:-/tmp/chu-dev-stack}"
export CHU_DEV_USER_PASSWORD="$(cat "$STATE/dev_password")"
export CHU_ADMIN_CLIENT_SECRET="$(cat "$STATE/admin_client_secret")"
export SHOTS_DIR="${SHOTS_DIR:-}"
for f in smoke lab-pharmacy consultation stock staff hosp-imaging direction-admin responsive; do
  echo "== $f"
  node "apps/portal/e2e/$f.mjs"
done
echo "Tous les scénarios sont passés."
