#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-QA-003) — dedicated realtime E2E setup + runner.
#
# Reads the git-ignored local env (xtrace off), asserts the dedicated DB name,
# migrates it, then runs the realtime Playwright config. Fixtures are generated
# by the per-test dedicated seed flow, not shared by this script (backend A on
# 3112 + Vite on 5182, reuse=false). trap only cleans PIDs this script records.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/server"
ENV_FILE="${RT_ENV_FILE:-$ROOT/.env.notification-realtime.local}"
PREPARE_ONLY="${PREPARE_ONLY:-false}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[e2e] missing local env file: $ENV_FILE" >&2
  exit 1
fi

set +x
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
true

case "$TEST_DATABASE_URL" in
  */monexus_test_notification_realtime?schema=public) ;;
  *) echo "[e2e] TEST_DATABASE_URL must point to monexus_test_notification_realtime" >&2; exit 1 ;;
esac

export TEST_DATABASE_URL

# 1. Migrate + seed the dedicated DB.
(cd "$SERVER" && DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy >/dev/null)
echo "[e2e] migrated dedicated DB"

if [[ "$PREPARE_ONLY" == "true" ]]; then
  echo "[e2e] prepared (migrate only)"
  exit 0
fi

# 2. Run the realtime Playwright suite.
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "[e2e] starting realtime Playwright suite (backend 3112 + vite 5182)"
(cd "$ROOT" && TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  npx playwright test --config playwright.notification-realtime.config.ts "$@")
