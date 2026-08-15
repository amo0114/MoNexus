#!/usr/bin/env bash
# verify-catalog-ops-e2e.sh — PAR-CMI-001 Cross-spec Integration lane browser gate.
#
# Codifies the verified runner sequence from docs/specs/cmi-qa-closeout.plan.md
# (附:catalog-ops e2e 运行序列): disposable DB lifecycle via scripts/cmi/dbguard.sh
# → prisma migrate deploy → db:seed:force (full env mirror of
# playwright.catalog-ops.config.ts apiWebServerEnv) → local Xboard fixture server
# (port 3106, trap cleanup) → playwright run on the catalog-ops config.
#
# Usage:
#   bash scripts/verify-catalog-ops-e2e.sh                # full 4-spec suite
#   bash scripts/verify-catalog-ops-e2e.sh e2e/merchandising-smoke.spec.ts
#
# Secret-safety: the database URL is read from dbguard make-url-file and is
# NEVER echoed; all JWT/MFA values below are committed test-only statics
# (identical to playwright.catalog-ops.config.ts). Exit non-zero on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

NODE20_BIN="/root/.nvm/versions/node/v20.19.5/bin"
if [[ -d "$NODE20_BIN" ]]; then
  export PATH="$NODE20_BIN:$PATH"
fi

DBGUARD="$ROOT/scripts/cmi/dbguard.sh"
FIXTURE="$ROOT/scripts/cmi/xboard-fixture-server.mjs"
FIXTURE_PORT=3106
FAKA_SECRET='catalog-ops-e2e-faka-bridge-secret-0123456789abcdef'
export E2E_ADMIN_MFA_TOTP_SECRET="${E2E_ADMIN_MFA_TOTP_SECRET:-ABCDEFGHIJKLMNOPQRSTUVWXYZ234567}"

say() { echo "[cmi-e2e] $*"; }
FIXTURE_PID=""
cleanup() {
  if [[ -n "$FIXTURE_PID" ]]; then
    kill "$FIXTURE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

say "recreating disposable integration database"
bash "$DBGUARD" drop >/dev/null
bash "$DBGUARD" create >/dev/null
URL_FILE="$(bash "$DBGUARD" make-url-file)"
CATALOG_OPS_DATABASE_URL="$(cat "$URL_FILE")"
rm -f "$URL_FILE"
export CATALOG_OPS_DATABASE_URL

say "migrate deploy + seed:force"
(
  cd server
  DATABASE_URL="$CATALOG_OPS_DATABASE_URL" npx prisma migrate deploy >/dev/null
  NODE_ENV=test DATABASE_URL="$CATALOG_OPS_DATABASE_URL" \
    FRONTEND_ORIGIN='http://127.0.0.1:5180' COOKIE_SECURE=false API_RATE_LIMIT_MAX=3000 \
    JWT_SECRET='catalog-ops-e2e-jwt-secret-at-least-32-characters' \
    MFA_ENCRYPTION_KEY='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' \
    E2E_ADMIN_MFA_TOTP_SECRET="$E2E_ADMIN_MFA_TOTP_SECRET" \
    REDIS_ENABLED=false REDIS_REQUIRED=false \
    NOTIFICATION_ENABLED=false NOTIFICATION_EMAIL_ENABLED=false \
    FAKA_BRIDGE_URL="http://127.0.0.1:${FIXTURE_PORT}/order-paid" \
    FAKA_BRIDGE_STATUS_URL="http://127.0.0.1:${FIXTURE_PORT}/order-status" \
    FAKA_BRIDGE_REVOKE_URL="http://127.0.0.1:${FIXTURE_PORT}/order-revoke" \
    FAKA_BRIDGE_SECRET="$FAKA_SECRET" \
    FAKA_BRIDGE_ALLOW_INSECURE_TARGETS=true STORAGE_UI_CONFIG_ENABLED=false \
    npm run db:seed:force >/dev/null
)

say "starting xboard fixture server on :${FIXTURE_PORT}"
node "$FIXTURE" --port "$FIXTURE_PORT" --secret "$FAKA_SECRET" >/tmp/cmi-e2e-fixture.log 2>&1 &
FIXTURE_PID=$!
sleep 1
if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then
  say "fixture server failed to start (see /tmp/cmi-e2e-fixture.log)"
  exit 1
fi

PLAYWRIGHT_CONFIG="${CATALOG_OPS_PLAYWRIGHT_CONFIG:-playwright.catalog-ops.config.ts}"
say "running playwright ($PLAYWRIGHT_CONFIG)"
npx playwright test --config "$PLAYWRIGHT_CONFIG" "$@"
say "catalog-ops e2e gate: PASS"
