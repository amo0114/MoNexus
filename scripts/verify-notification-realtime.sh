#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-QA-005) — final realtime verify gate.
#
# Runs the local implementation gates in order and fails loudly on any red result:
#   runtime, backend build, frontend build, backend vitest suites, frontend
#   unit tests, browser realtime E2E, multi-instance, git diff --check,
#   schema/migration drift, secret scan. AC-RT-028 evidence is covered by the
#   backend realtime-dispatcher suite; AC-RT-029 / CHK-INF-007 session gate
#   requires a production-like endpoint and is only run by explicit --release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${RT_ENV_FILE:-$ROOT/.env.notification-realtime.local}"
FROZEN_COMMIT="22ae95c8"
DEVELOP_BASE="da38dd0580eeac737f5291556b9dbdf832d91970"
MODE="local"

case "${1:---local}" in
  --local) MODE="local" ;;
  --release) MODE="release" ;;
  --help)
    echo "usage: $0 [--local|--release]"
    exit 0
    ;;
  *) echo "usage: $0 [--local|--release]" >&2; exit 2 ;;
esac

step() { echo; echo "==== $* ===="; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

BASELINE_PRISMA_DIFF='-- AlterTable
ALTER TABLE "StorageProviderConfig" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StorageRuntime" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StoredObject" ALTER COLUMN "updatedAt" DROP DEFAULT;'

check_prisma_diff_result() {
  local status="$1" output="$2"
  if [[ "$status" == 0 && -z "$output" ]]; then
    return 0
  fi
  if [[ "$status" == 2 && "$output" == "$BASELINE_PRISMA_DIFF" ]]; then
    echo "[BASELINE] inherited develop drift (exact allowlist)"
    return 0
  fi
  printf '%s\n' "$output" >&2
  return 1
}

prisma_diff_self_test() {
  check_prisma_diff_result 2 "$BASELINE_PRISMA_DIFF" || return 1
  local fourth="$BASELINE_PRISMA_DIFF

-- AlterTable
ALTER TABLE \"Unexpected\" ALTER COLUMN \"updatedAt\" DROP DEFAULT;"
  check_prisma_diff_result 2 "$fourth" && return 1
  local missing='-- AlterTable
ALTER TABLE "StorageProviderConfig" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StoredObject" ALTER COLUMN "updatedAt" DROP DEFAULT;'
  check_prisma_diff_result 2 "$missing" && return 1
  check_prisma_diff_result 0 "" || return 1
}

require_clean_worktree() {
  local status
  status="$(git status --porcelain --untracked-files=all)"
  [[ -z "$status" ]] || {
    echo "$status" >&2
    fail "final evidence requires a clean worktree"
  }
}

require_artifact_line() {
  local file="$1"
  local expected="$2"
  grep -Fqx "$expected" "$file" || fail "release artifact $file is missing: $expected"
}

require_release_artifact() {
  local variable_name="$1"
  local label="$2"
  local path="${!variable_name:-}"
  [[ -n "$path" && -s "$path" ]] || fail "$variable_name must name a non-empty $label artifact"
  find "$path" -type f -mmin -10080 -print -quit | grep -q . || fail "$label artifact is older than 7 days"
  require_artifact_line "$path" "result=PASS"
  require_artifact_line "$path" "head=$(git rev-parse HEAD)"
  printf '%s\t%s\n' "$label" "$path"
}

cd "$ROOT"

step "0. immutable baseline + clean evidence boundary"
git merge-base --is-ancestor "$FROZEN_COMMIT" HEAD || fail "$FROZEN_COMMIT is not an ancestor of HEAD"
require_clean_worktree
echo "head=$(git rev-parse HEAD)"
echo "node=$(node --version) npm=$(npm --version)"

step "1. runtime + builds"
npm run check:runtime
(cd server && npm run build)
npm run build

step "2. nginx config + gate self-tests"
npm run check:nginx
bash scripts/verify-notification-realtime-listen-session.sh --self-test
bash scripts/verify-notification-realtime-proxy.sh --self-test

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
  src/__tests__/faka-bridge-config.test.ts)

step "4. frontend unit tests"
npx vitest run src/realtime/ src/utils/

step "5. browser realtime E2E (backend 3112 + vite 5182)"
bash scripts/verify-notification-realtime-e2e.sh

step "6. multi-instance (A 3112 stream / B 3113 order)"
bash scripts/verify-notification-realtime-multi-instance.sh

step "7. git/schema/migration/secret evidence"
git diff --check || fail "git diff --check failed"
git diff --exit-code -- server/prisma/schema.prisma server/prisma/migrations || \
  fail "worktree schema/migrations must be unchanged"
git diff --exit-code "$FROZEN_COMMIT..HEAD" -- server/prisma/schema.prisma server/prisma/migrations || \
  fail "schema/migrations changed after the frozen commit"
git diff --exit-code "$DEVELOP_BASE..HEAD" -- server/prisma/schema.prisma server/prisma/migrations || \
  fail "schema/migrations differ from the frozen develop baseline"
(cd server && DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate status)
step "7a. exact Prisma live-diff baseline allowlist self-test"
prisma_diff_self_test || fail "Prisma diff allowlist self-test failed"
prisma_diff_output_file="$(mktemp)"
tmp_secret=""
trap 'rm -f "$tmp_secret" "$prisma_diff_output_file"' EXIT
set +e
(cd server && npx prisma migrate diff \
  --from-url "$TEST_DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script --exit-code) >"$prisma_diff_output_file" 2>&1
prisma_diff_status=$?
set -e
prisma_diff_output="$(<"$prisma_diff_output_file")"
check_prisma_diff_result "$prisma_diff_status" "$prisma_diff_output" || \
  fail "Prisma live diff contains drift outside the exact develop baseline"
# Assemble markers at runtime so this verifier is included in the tracked-text scan.
marker_begin='BE''GIN'
secret_pattern="${marker_begin}[[:space:]]+(RSA|OPENSSH|EC)[[:space:]]+PRIVATE[[:space:]]+KEY|$(printf '%s' '-'{5})${marker_begin}[[:space:]]+PGP"
if git grep -nE "$secret_pattern" -- . ':!node_modules' >/dev/null 2>&1; then
  fail "secret material found in the tree"
fi
tmp_secret="$(mktemp)"
printf '%s%s RSA PRIVATE KEY%s\n' '-----' "$marker_begin" '-----' >"$tmp_secret"
grep -nE "$secret_pattern" "$tmp_secret" >/dev/null || fail "secret scan self-test did not detect synthetic positive"
echo "git/schema/migration/secret checks passed (synthetic positive detected)"

step "8. final clean evidence boundary"
require_clean_worktree

echo
echo "[PASS] local implementation gate"

if [[ "$MODE" == "local" ]]; then
  echo "[PENDING] deployment/release gates: production-like AC-RT-029; deployed proxy/log smoke; staging latency; rollout/rollback rehearsal; Owner review"
  exit 0
fi

step "9. explicit deployment/release gates"
bash scripts/verify-notification-realtime-listen-session.sh
: "${NOTIFICATION_REALTIME_PROXY_BASE:?NOTIFICATION_REALTIME_PROXY_BASE is required for --release}"
: "${NOTIFICATION_REALTIME_PROXY_TOKEN:?NOTIFICATION_REALTIME_PROXY_TOKEN is required for --release}"
bash scripts/verify-notification-realtime-proxy.sh

staging_artifact="$(require_release_artifact RT_STAGING_LATENCY_EVIDENCE_FILE "staging latency")"
staging_path="${staging_artifact#*$'\t'}"
sample_count="$(sed -n 's/^sample_count=//p' "$staging_path" | tail -1)"
p95_ms="$(sed -n 's/^p95_ms=//p' "$staging_path" | tail -1)"
p99_ms="$(sed -n 's/^p99_ms=//p' "$staging_path" | tail -1)"
[[ "$sample_count" =~ ^[0-9]+$ && "$p95_ms" =~ ^[0-9]+$ && "$p99_ms" =~ ^[0-9]+$ ]] || \
  fail "staging artifact requires integer sample_count/p95_ms/p99_ms"
(( sample_count >= 100 && p95_ms <= 2000 && p99_ms <= 5000 )) || \
  fail "staging latency budget failed"

log_artifact="$(require_release_artifact RT_DEPLOYED_LOG_EVIDENCE_FILE "deployed log inspection")"
log_path="${log_artifact#*$'\t'}"
require_artifact_line "$log_path" "nginx=PASS"
require_artifact_line "$log_path" "app=PASS"
if [[ "${DEPLOY_TOPOLOGY:-nginx}" == "caddy" ]]; then require_artifact_line "$log_path" "caddy=PASS"; fi

rollout_artifact="$(require_release_artifact RT_ROLLOUT_EVIDENCE_FILE "rollout rehearsal")"
rollout_path="${rollout_artifact#*$'\t'}"
require_artifact_line "$rollout_path" "backend_first=PASS"
require_artifact_line "$rollout_path" "flag_on=PASS"
require_artifact_line "$rollout_path" "frontend_after=PASS"

rollback_artifact="$(require_release_artifact RT_ROLLBACK_EVIDENCE_FILE "rollback rehearsal")"
rollback_path="${rollback_artifact#*$'\t'}"
require_artifact_line "$rollback_path" "flag_off=PASS"
require_artifact_line "$rollback_path" "code_rollback=PASS"
require_artifact_line "$rollback_path" "rest_polling_history=PASS"

owner_artifact="$(require_release_artifact RT_OWNER_REVIEW_EVIDENCE_FILE "Owner review")"
owner_path="${owner_artifact#*$'\t'}"
require_artifact_line "$owner_path" "decision=APPROVED"
grep -Eq '^reviewer=.+$' "$owner_path" || fail "Owner review artifact requires reviewer"

echo
echo "[PASS] deployment/release evidence gate"
