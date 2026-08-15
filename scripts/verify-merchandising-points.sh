#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; SERVER="$ROOT/server"; DBGUARD="$ROOT/scripts/cmi/dbguard.sh"; DB_NAME=monexus_test_catalog_merch_integration; URL_FILE=""; TMP_DIR="$(mktemp -d /tmp/monexus-merch-points-XXXXXX)"
cleanup(){ [[ -n "$URL_FILE" && -f "$URL_FILE" ]] && rm -f "$URL_FILE"; rm -rf "$TMP_DIR"; [[ -f "$DBGUARD" ]] && bash "$DBGUARD" drop "$DB_NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT INT TERM
fail(){ printf '[merch-points] FAIL: %s\n' "$*" >&2; exit 1; }
[[ -f "$DBGUARD" && -x "$SERVER/node_modules/.bin/vitest" ]] || fail 'dbguard or server Vitest unavailable'; BASE_URL="${DATABASE_URL:-${TEST_DATABASE_URL:-}}"; [[ -n "$BASE_URL" ]] || fail 'DATABASE_URL/TEST_DATABASE_URL required'; export DATABASE_URL="$BASE_URL"; export PATH="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}:$PATH"; [[ "$(node -p 'process.versions.node')" == 20.19.5 ]] || fail 'Node 20.19.5 required'
bash "$DBGUARD" create "$DB_NAME" >/dev/null; URL_FILE="$(bash "$DBGUARD" make-url-file "$DB_NAME")"; chmod 600 "$URL_FILE"; export TEST_DATABASE_URL="$(<"$URL_FILE")"; (cd "$SERVER" && DATABASE_URL="$TEST_DATABASE_URL" ./node_modules/.bin/prisma migrate deploy --schema "$SERVER/prisma/schema.prisma" >/dev/null)
tests=(src/modules/merchandising/__tests__/promotions-billing.test.ts); [[ -f "$SERVER/${tests[0]}" ]] || fail 'required promotions-billing test missing'; for t in src/modules/merchandising/__tests__/points*test.ts src/modules/merchandising/__tests__/*admin*component*test.ts; do [[ -f "$SERVER/$t" ]] && tests+=("$t"); done
printf '[merch-points] command: vitest run promotions-billing and points/admin contracts (DATABASE_URL redacted)\n'; set +e; (cd "$SERVER" && DATABASE_URL="$TEST_DATABASE_URL" ./node_modules/.bin/vitest run --config "$SERVER/vitest.config.ts" "${tests[@]}") >"$TMP_DIR/vitest.log" 2>&1; rc=$?; set -e; ((rc==0)) || { printf '[merch-points] FAIL: vitest exit %d\n' "$rc" >&2; exit "$rc"; }; grep -E 'Test Files|Tests ' "$TMP_DIR/vitest.log" | tail -2 | sed 's/^/[merch-points] summary: /' || true
