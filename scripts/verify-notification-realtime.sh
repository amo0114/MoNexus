#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-QA-005) — final realtime verify gate.
#
# Runs the full stack gates in order and fails loudly on any red result:
#   runtime, backend build, frontend build, backend vitest suites, frontend
#   unit tests, browser realtime E2E, multi-instance, git diff --check,
#   schema/migration drift, secret scan. AC-RT-028 evidence is covered by the
#   backend realtime-dispatcher suite; AC-RT-029 / CHK-INF-007 session gate
#   requires a production-like endpoint and is run via
#   scripts/verify-notification-realtime-listen-session.sh (deployment gate).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${RT_ENV_FILE:-$ROOT/.env.notification-realtime.local}"

step() { echo; echo "==== $* ===="; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

cd "$ROOT"

step "1. runtime + builds"
npm run check:runtime >/dev/null
(cd server && npm run build) >/dev/null
npm run build >/dev/null
echo "builds OK"

step "2. nginx config"
npm run check:nginx >/dev/null
echo "nginx OK"

if [[ ! -f "$ENV_FILE" ]]; then
  fail "missing local env file $ENV_FILE"
fi
set +x
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
true

case "$TEST_DATABASE_URL" in
  */monexus_test_notification_realtime?schema=public) ;;
  *) fail "TEST_DATABASE_URL must point to monexus_test_notification_realtime" ;;
esac

step "3. backend vitest (notifications + health + config guards)"
(cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run \
  src/modules/notifications/ \
  src/modules/health/ \
  src/__tests__/config-realtime-guards.test.ts \
  src/__tests__/config-production-guards.test.ts \
  src/__tests__/faka-bridge-config.test.ts >/dev/null)
echo "backend tests OK"

step "4. frontend unit tests"
npx vitest run src/realtime/ src/utils/ >/dev/null
echo "frontend unit OK"

step "5. browser realtime E2E (backend 3112 + vite 5182)"
bash scripts/verify-notification-realtime-e2e.sh >/dev/null
echo "browser E2E OK"

step "6. multi-instance (A 3112 stream / B 3113 order)"
bash scripts/verify-notification-realtime-multi-instance.sh >/dev/null
echo "multi-instance OK"

step "7. git diff --check + schema/migration drift + secret scan"
git diff --check || fail "git diff --check failed"
(cd server && git diff --quiet -- prisma/schema.prisma prisma/migrations) || \
  fail "schema/migrations must be unchanged"
# Assemble markers at runtime so this verifier is included in the tracked-text scan.
marker_begin='BE''GIN'
secret_pattern="${marker_begin}[[:space:]]+(RSA|OPENSSH|EC)[[:space:]]+PRIVATE[[:space:]]+KEY|$(printf '%s' '-'{5})${marker_begin}[[:space:]]+PGP"
if git grep -nE "$secret_pattern" -- . ':!node_modules' >/dev/null 2>&1; then
  fail "secret material found in the tree"
fi
tmp_secret="$(mktemp)"; trap 'rm -f "$tmp_secret"' EXIT
printf '%s%s RSA PRIVATE KEY%s\n' '-----' "$marker_begin" '-----' >"$tmp_secret"
grep -nE "$secret_pattern" "$tmp_secret" >/dev/null || fail "secret scan self-test did not detect synthetic positive"
echo "git/schema/secret OK (clean + synthetic positive)"

step "8. AC-RT-029 / CHK-INF-007 (deployment gate, requires production-like endpoint)"
if [[ "${NOTIFICATION_REALTIME_SESSION_GATE:-false}" == "true" ]]; then
  bash scripts/verify-notification-realtime-listen-session.sh
else
  echo "[PASS] local PASS"
  echo "[PENDING] release PENDING (external evidence required)"
fi

echo
echo "[PASS] local verification completed; release PENDING"
