#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NODE20_BIN="/root/.nvm/versions/node/v20.19.5/bin"
[[ -d "$NODE20_BIN" ]] && export PATH="$NODE20_BIN:$PATH"
DBGUARD="$ROOT/scripts/cmi/dbguard.sh"
export DATABASE_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' "$(git -C "$ROOT" rev-parse --git-common-dir)/../server/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)}"
[[ -n "$DATABASE_URL" ]] || { echo 'DATABASE_URL is required' >&2; exit 1; }
cleanup() { bash "$DBGUARD" drop >/dev/null 2>&1 || true; }
trap cleanup EXIT
bash "$DBGUARD" drop >/dev/null
bash "$DBGUARD" create >/dev/null
URL_FILE="$(bash "$DBGUARD" make-url-file)"
TEST_URL="$(cat "$URL_FILE")"
rm -f "$URL_FILE"
(
  cd server
  DATABASE_URL="$TEST_URL" npx prisma migrate deploy >/dev/null
  NODE_ENV=test DATABASE_URL="$TEST_URL" TEST_DATABASE_URL="$TEST_URL" REDIS_ENABLED=false REDIS_REQUIRED=false \
    JWT_SECRET='cmi-benchmark-jwt-secret-at-least-32-characters' FRONTEND_ORIGIN='http://127.0.0.1:5173' COOKIE_SECURE=false \
    CMI_BENCH_SAMPLES="${CMI_BENCH_SAMPLES:-30}" npx tsx ../scripts/cmi/benchmark-100k-orders.ts
)
