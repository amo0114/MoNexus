#!/usr/bin/env bash
# Merchandising points/billing gate: isolated REAL-PG server tests plus UI contracts.
set +x
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/server"
DBGUARD="$ROOT/scripts/cmi/dbguard.sh"
DB_NAME='monexus_test_catalog_merch_integration'
PRISMA="$SERVER/node_modules/.bin/prisma"
VITEST="$SERVER/node_modules/.bin/vitest"
SCHEMA="$SERVER/prisma/schema.prisma"
URL_FILE=''
TMP_DIR="$(mktemp -d /tmp/monexus-merch-points-XXXXXX)"

say() { printf '[merch-points] %s\n' "$*"; }
fail() { say "FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "$URL_FILE" && -f "$URL_FILE" ]] && rm -f "$URL_FILE"
  rm -rf "$TMP_DIR"
  [[ -f "$DBGUARD" ]] && bash "$DBGUARD" drop "$DB_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export PATH="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}:$PATH"
[[ "$(node --version)" == 'v20.19.5' ]] || fail "Node 20.19.5 required (got $(node --version))"
[[ "$(npm --version)" == 10.* ]] || fail "npm 10 required (got $(npm --version))"
[[ -f "$DBGUARD" && -x "$PRISMA" && -x "$VITEST" && -f "$SCHEMA" ]] || fail 'dbguard/prisma/vitest/schema missing'

bash "$DBGUARD" drop "$DB_NAME" >/dev/null 2>&1 || true
bash "$DBGUARD" create "$DB_NAME" >/dev/null
URL_FILE="$(bash "$DBGUARD" make-url-file "$DB_NAME")"
chmod 600 "$URL_FILE"
[[ "$(stat -c '%a' "$URL_FILE")" == 600 ]] || fail 'private URL file is not mode 600'
TEST_URL="$(<"$URL_FILE")"

if ! (cd "$SERVER" && DATABASE_URL="$TEST_URL" "$PRISMA" migrate deploy --schema "$SCHEMA") >"$TMP_DIR/migrate.log" 2>&1; then
  fail 'prisma migrate deploy failed (raw log suppressed)'
fi

server_tests=(
  src/modules/merchandising/__tests__/promotions-billing.test.ts
  src/modules/merchandising/__tests__/promotions-campaign.test.ts
  src/modules/merchandising/__tests__/promotions-idempotency.test.ts
  src/modules/merchandising/__tests__/promotions-dto-state.test.ts
)
for test_file in "${server_tests[@]}"; do [[ -f "$SERVER/$test_file" ]] || fail "required test missing: $test_file"; done
server_log="$TMP_DIR/server-vitest.log"
say 'running points/billing REAL-PG server tests (database redacted)'
set +e
(
  cd "$SERVER"
  TEST_DATABASE_URL="$TEST_URL" DATABASE_URL="$TEST_URL" \
    REDIS_ENABLED=false REDIS_REQUIRED=false \
    "$VITEST" run --config "$SERVER/vitest.config.ts" "${server_tests[@]}"
) >"$server_log" 2>&1
rc=$?
set -e
(( rc == 0 )) || fail "server Vitest exited $rc (raw log suppressed)"
if grep -Eq 'Test Files .* skipped|Tests .* skipped' "$server_log"; then fail 'points server suite reported skipped files/tests'; fi
grep -E 'Test Files|Tests ' "$server_log" | tail -2 | sed 's/^/[merch-points] server summary: /' || fail 'server Vitest summary missing'

ui_tests=(
  src/components/merchandising/AdminPromotionCampaignManager.test.tsx
  src/components/merchandising/AdminPromotionPackageManager.test.tsx
  src/components/merchandising/PromotionPackagePicker.test.tsx
)
for test_file in "${ui_tests[@]}"; do [[ -f "$ROOT/$test_file" ]] || fail "required UI test missing: $test_file"; done
ui_log="$TMP_DIR/ui-vitest.log"
say 'running points/promotion UI contract tests'
set +e
(cd "$ROOT" && "$ROOT/node_modules/.bin/vitest" run --config "$ROOT/vitest.config.ts" "${ui_tests[@]}") >"$ui_log" 2>&1
rc=$?
set -e
(( rc == 0 )) || fail "UI Vitest exited $rc (raw log suppressed)"
if grep -Eq 'Test Files .* skipped|Tests .* skipped' "$ui_log"; then fail 'points UI suite reported skipped files/tests'; fi
grep -E 'Test Files|Tests ' "$ui_log" | tail -2 | sed 's/^/[merch-points] UI summary: /' || fail 'UI Vitest summary missing'
say 'PASS (database and temporary artifacts cleaned on exit)'
