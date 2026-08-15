#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/server"; DBGUARD="$ROOT/scripts/cmi/dbguard.sh"; DB_NAME=monexus_test_catalog_merch_integration; URL_FILE=""; TMP_DIR="$(mktemp -d /tmp/monexus-merch-ranking-XXXXXX)"
cleanup(){ [[ -n "$URL_FILE" && -f "$URL_FILE" ]] && rm -f "$URL_FILE"; rm -rf "$TMP_DIR"; [[ -f "$DBGUARD" ]] && bash "$DBGUARD" drop "$DB_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
fail(){ printf '[merch-ranking] FAIL: %s\n' "$*" >&2; exit 1; }
[[ -x "$SERVER/node_modules/.bin/vitest" ]] || fail 'server Vitest unavailable'; [[ -f "$DBGUARD" ]] || fail "missing $DBGUARD"
BASE_URL="${DATABASE_URL:-${TEST_DATABASE_URL:-}}"; if [[ -z "$BASE_URL" && -f "$SERVER/.env" ]]; then BASE_URL="$(grep -E '^DATABASE_URL=' "$SERVER/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"; fi; [[ -n "$BASE_URL" ]] || fail 'DATABASE_URL/TEST_DATABASE_URL or server/.env required'; export DATABASE_URL="$BASE_URL"
export PATH="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}:$PATH"; [[ "$(node -p 'process.versions.node')" == 20.19.5 ]] || fail 'Node 20.19.5 required'
bash "$DBGUARD" create "$DB_NAME" >/dev/null; URL_FILE="$(bash "$DBGUARD" make-url-file "$DB_NAME")"; chmod 600 "$URL_FILE"; export TEST_DATABASE_URL="$(<"$URL_FILE")"
(cd "$SERVER" && DATABASE_URL="$TEST_DATABASE_URL" ./node_modules/.bin/prisma migrate deploy --schema "$SERVER/prisma/schema.prisma" >/dev/null)
tests=(src/modules/merchandising/__tests__/ranking-compute-projection.test.ts src/modules/merchandising/__tests__/ranking-lifecycle.test.ts); for t in "${tests[@]}"; do [[ -f "$SERVER/$t" ]] || fail "required test missing: $t"; done
printf '[merch-ranking] command: vitest run ranking-compute-projection.test.ts ranking-lifecycle.test.ts (DATABASE_URL redacted)\n'
set +e; (cd "$SERVER" && DATABASE_URL="$TEST_DATABASE_URL" ./node_modules/.bin/vitest run --config "$SERVER/vitest.config.ts" "${tests[@]}") >"$TMP_DIR/vitest.log" 2>&1; rc=$?; set -e
((rc==0)) || { printf '[merch-ranking] FAIL: vitest exit %d\n' "$rc" >&2; exit "$rc"; }; grep -E 'Test Files|Tests ' "$TMP_DIR/vitest.log" | tail -2 | sed 's/^/[merch-ranking] summary: /' || true
