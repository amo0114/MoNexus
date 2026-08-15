#!/usr/bin/env bash
# Merchandising ranking gate: isolated PostgreSQL + ranking unit/REAL-PG tests.
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
TMP_DIR="$(mktemp -d /tmp/monexus-merch-ranking-XXXXXX)"

say() { printf '[merch-ranking] %s\n' "$*"; }
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

# dbguard resolves DATABASE_URL from the caller or the canonical main worktree
# server/.env. Only the frozen CMI database may be touched.
bash "$DBGUARD" drop "$DB_NAME" >/dev/null 2>&1 || true
bash "$DBGUARD" create "$DB_NAME" >/dev/null
URL_FILE="$(bash "$DBGUARD" make-url-file "$DB_NAME")"
chmod 600 "$URL_FILE"
[[ "$(stat -c '%a' "$URL_FILE")" == 600 ]] || fail 'private URL file is not mode 600'
TEST_URL="$(<"$URL_FILE")"

if ! (cd "$SERVER" && DATABASE_URL="$TEST_URL" "$PRISMA" migrate deploy --schema "$SCHEMA") >"$TMP_DIR/migrate.log" 2>&1; then
  fail 'prisma migrate deploy failed (raw log suppressed)'
fi

tests=(
  src/modules/merchandising/__tests__/ranking-compute-projection.test.ts
  src/modules/merchandising/__tests__/ranking-lifecycle.test.ts
)
for test_file in "${tests[@]}"; do [[ -f "$SERVER/$test_file" ]] || fail "required test missing: $test_file"; done

LOG="$TMP_DIR/vitest.log"
say 'running ranking compute + REAL-PG lifecycle tests (database redacted)'
set +e
(
  cd "$SERVER"
  TEST_DATABASE_URL="$TEST_URL" DATABASE_URL="$TEST_URL" \
    REDIS_ENABLED=false REDIS_REQUIRED=false \
    "$VITEST" run --config "$SERVER/vitest.config.ts" "${tests[@]}"
) >"$LOG" 2>&1
rc=$?
set -e
if (( rc != 0 )); then fail "vitest exited $rc (raw log suppressed)"; fi
if grep -Eq 'Test Files .* skipped|Tests .* skipped' "$LOG"; then
  fail 'ranking suite reported skipped files/tests'
fi
summary="$(grep -E 'Test Files|Tests ' "$LOG" | tail -2 || true)"
[[ -n "$summary" ]] || fail 'vitest summary missing'
printf '%s\n' "$summary" | sed 's/^/[merch-ranking] summary: /'
say 'PASS (database and temporary artifacts cleaned on exit)'
