#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CMI verify-catalog-ops-backend — Catalog Operations Backend verification
# entry point for the catalog-merch integration card.
#
# Verifies the Catalog Operations backend (catalog / merchant / products lanes)
# against REAL PostgreSQL using ONLY the single guard-allowlisted disposable
# database frozen in PAR-CMI-001 §2:
#     monexus_test_catalog_merch_integration
# every create/connect/drop goes through `bash scripts/cmi/dbguard.sh` — no
# direct psql, no other database name is ever touched.
#
# Secret safety (hard rules):
#   * `set +x` is forced — an inherited xtrace can never leak secrets.
#   * The base DB URL is resolved at startup in priority order:
#       $DATABASE_URL  →  $TEST_DATABASE_URL  →  <canonical-root>/server/.env
#     where <canonical-root> is the main repository (git common dir), i.e.
#     /root/projects/MoNexus-new/server/.env. Never .env.example, never a
#     hardcoded credential. It is exported as DATABASE_URL for dbguard + Prisma
#     and is NEVER printed/echoed.
#   * The disposable DB URL is materialised into a private 0600 temp file via
#     dbguard make-url-file and is passed to prisma/vitest as per-command env —
#     never echoed, never argv, never a script variable that leaves this process.
#   * Every prisma command runs from the server cwd with an explicit absolute
#     --schema path, using ONLY the locally-pinned ./node_modules/.bin/prisma.
#     No `db push`, no `db reset`, no `migrate dev` (it could prompt/reset), and
#     no unpinned `npx`.
#   * Test output is captured to a private /tmp log and never echoed, so an
#     InventoryItem `content` / storage object key can never leak through this
#     script's stdout/stderr.
#
# Scope discipline (this card only):
#   * A scope gate asserts that, relative to the current HEAD, the working tree /
#     index is either CLEAN or contains ONLY this script itself. Any other
#     modified or untracked path (including the protected
#     src/components/Layout.tsx, src/stores/appStore.ts,
#     server/prisma/schema.prisma, server/prisma/migrations/**) makes the gate
#     fail and the whole run fail.
#   * No Notification-specific test is ever added to the suite.
#
# Fail-fast: any gate failure stops the run immediately (non-zero exit); the
# EXIT trap still cleans up.
# ─────────────────────────────────────────────────────────────────────────────

set +x
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"
DBGUARD="$PROJECT_ROOT/scripts/cmi/dbguard.sh"
SELF_REL="scripts/verify-catalog-ops-backend.sh"
EXPECTED_DB='monexus_test_catalog_merch_integration'

# Canonical (main) repo root — same derivation as scripts/cmi/dbguard.sh, so the
# .env fallback below always agrees with what dbguard would resolve.
COMMON_GIT_DIR="$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir)"
if [[ "$COMMON_GIT_DIR" = /* ]]; then
  CANONICAL_ROOT="$(cd "$COMMON_GIT_DIR/.." && pwd)"
else
  CANONICAL_ROOT="$(cd "$PROJECT_ROOT/$COMMON_GIT_DIR/.." && pwd)"
fi
CANONICAL_SERVER_ENV="$CANONICAL_ROOT/server/.env"

# ── Resolve the base DB URL (never printed). ─────────────────────────────────
# Priority: $DATABASE_URL env → $TEST_DATABASE_URL env → canonical server/.env.
# Fails loudly if none exists. Never .env.example, never a hardcoded credential.
BASE_URL="${DATABASE_URL:-}"
if [[ -z "$BASE_URL" ]]; then
  BASE_URL="${TEST_DATABASE_URL:-}"
fi
if [[ -z "$BASE_URL" && -f "$CANONICAL_SERVER_ENV" ]]; then
  BASE_URL="$(grep -E '^DATABASE_URL=' "$CANONICAL_SERVER_ENV" | head -1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [[ -z "$BASE_URL" ]]; then
  printf '[verify-catalog-ops-backend] FATAL: no DATABASE_URL / TEST_DATABASE_URL in env and no %s\n' "$CANONICAL_SERVER_ENV" >&2
  printf '[verify-catalog-ops-backend]        a verifying agent must inject DATABASE_URL (never .env.example / hardcoded)\n' >&2
  exit 2
fi
export DATABASE_URL="$BASE_URL"

# ── Node 20.19.5 / npm 10 (frozen engine floor for this card). ───────────────
NODE20_BIN="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}"
export PATH="$NODE20_BIN:$PATH"

PRISMA_BIN="$SERVER_DIR/node_modules/.bin/prisma"
VITEST_BIN="$SERVER_DIR/node_modules/.bin/vitest"
SCHEMA="$SERVER_DIR/prisma/schema.prisma"
MIGRATIONS="$SERVER_DIR/prisma/migrations"
VITEST_CONFIG="$SERVER_DIR/vitest.config.ts"
URL_FILE=""  # private 0600 CMI DB url file, created in Gate 1

# The Catalog Operations backend test suite (24 files). Notification-specific
# tests are deliberately NOT part of this list.
TEST_FILES=(
  src/modules/catalog/bootstrap.test.ts
  src/modules/catalog/resolver.test.ts
  src/modules/catalog/categorySchema.test.ts
  src/modules/catalog/categoryService.test.ts
  src/modules/catalog/categoryAdminRoutes.test.ts
  src/modules/catalog/applicationSchema.test.ts
  src/modules/catalog/applicationService.test.ts
  src/modules/catalog/applicationRoutes.test.ts
  src/modules/catalog/publicationReadiness.test.ts
  src/modules/catalog/publicationRoutes.test.ts
  src/modules/catalog/externalCatalog.test.ts
  src/modules/catalog/contentSanitizer.test.ts
  src/modules/catalog/fakaPreviewConfirm.test.ts
  src/modules/merchant/inventory.test.ts
  src/modules/merchant/capacity-adjust.test.ts
  src/modules/merchant/product-images.test.ts
  src/modules/merchant/instant-fixed-product.test.ts
  src/__tests__/offers.test.ts
  src/__tests__/faka-bridge-merchant-offer.test.ts
  src/__tests__/structured-delivery.test.ts
  src/__tests__/checkout-idempotency.test.ts
  src/modules/products/public-fields.test.ts
  src/modules/products/images.test.ts
  src/modules/products/catalog-merch-integration.test.ts
)

# ── Output bookkeeping. Every gate's REAL exit is counted by run_gate(). ─────
PASSED=0
FAILED=0
declare -a FAILED_GATES=()

say()  { printf '[verify-catalog-ops-backend] %s\n' "$*"; }
fail() { say "FAIL: $*"; FAILED_GATES+=("$*"); }

run_gate() {
  local label="$1"; shift
  local rc=0
  "$@" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    PASSED=$((PASSED+1))
    say "Gate $label -> PASS (exit 0)"
    return 0
  fi
  FAILED=$((FAILED+1))
  FAILED_GATES+=("gate_$label")
  say "Gate $label -> FAIL (exit $rc)"
  return 1
}

# ── Cleanup (trap + explicit). Idempotent, secret-safe. ─────────────────────
CLEANED=0
cleanup() {
  [[ "${CLEANED:-0}" == "1" ]] && return 0
  CLEANED=1
  say "cleanup: dropping CMI disposable database"
  bash "$DBGUARD" drop "$EXPECTED_DB" >/dev/null 2>&1 || true
  say "cleanup: removing /tmp/monexus-cmi-integration-* (private url file + logs)"
  rm -rf /tmp/monexus-cmi-integration-* 2>/dev/null || true
  return 0
}
# EXIT trap cleans up on every normal exit path. INT/TERM handlers explicitly
# exit with 130/143 so the script does NOT resume after cleanup; the EXIT trap
# then runs cleanup again, which is idempotent (CLEANED guard).
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Run prisma against the guarded CMI DB url file. Runs from the server cwd;
# DATABASE_URL is exported per command, never echoed, never argv.
run_prisma() { # $1 = url-file, rest = prisma args
  local uf="$1"; shift
  (cd "$SERVER_DIR" && DATABASE_URL="$(cat "$uf")" "$PRISMA_BIN" "$@")
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 0 — environment / branch / tooling / dbguard probe.
# ─────────────────────────────────────────────────────────────────────────────
gate_0_env() {
  say "── Gate 0: environment, branch, tooling ──"
  local node_v npm_v branch head
  node_v="$(node --version)"
  npm_v="$(npm --version)"
  say "node=$node_v npm=$npm_v"
  [[ "$node_v" == "v20.19.5" ]] || { fail "node must be v20.19.5 (got $node_v)"; return 1; }
  [[ "$npm_v" == 10.* ]] || { fail "npm must be 10.x (got $npm_v)"; return 1; }

  [[ -x "$PRISMA_BIN" ]] || { fail "prisma binary not found at $PRISMA_BIN"; return 1; }
  [[ -x "$VITEST_BIN" ]] || { fail "vitest binary not found at $VITEST_BIN"; return 1; }
  [[ -f "$VITEST_CONFIG" ]] || { fail "vitest config not found at $VITEST_CONFIG"; return 1; }
  [[ -f "$SCHEMA" ]] || { fail "prisma schema not found at $SCHEMA"; return 1; }
  [[ -d "$MIGRATIONS" ]] || { fail "migrations dir not found at $MIGRATIONS"; return 1; }
  # dbguard is invoked as `bash "$DBGUARD"`, so it only needs to be readable,
  # not executable (-x is NOT required).
  [[ -f "$DBGUARD" && -r "$DBGUARD" ]] || { fail "dbguard not found/readable at $DBGUARD"; return 1; }
  command -v psql >/dev/null 2>&1 || { fail "psql not found"; return 1; }

  branch="$(git -C "$PROJECT_ROOT" branch --show-current)"
  head="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  say "branch=$branch head=$head"
  [[ "$branch" == "feat/catalog-merch-integration" ]] || { fail "wrong branch: $branch"; return 1; }

  # dbguard must refuse any database name other than the frozen CMI db.
  if bash "$DBGUARD" make-url-file 'monexus_test_catalog_merch_TYPO' >/dev/null 2>&1; then
    fail "dbguard accepted a non-CMI database name"
    return 1
  fi
  say "dbguard refused a non-CMI database name"
  say "Gate 0 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 1 — DB lifecycle: drop → create → private 0600 url file (strict).
# The CMI disposable database is created fresh at the start of the run; the
# generated private 0600 url file is stored in the global URL_FILE for reuse
# by the prisma migrate and vitest gates.
# ─────────────────────────────────────────────────────────────────────────────
gate_1_db_lifecycle() {
  say "── Gate 1: drop/create CMI DB + private url file (0600) ──"
  bash "$DBGUARD" drop "$EXPECTED_DB" >/dev/null 2>&1 \
    || { fail "initial drop failed"; return 1; }
  say "initial drop: ok"
  bash "$DBGUARD" create "$EXPECTED_DB" >/dev/null \
    || { fail "create failed"; return 1; }
  say "create: ok"

  # make-url-file failure strictly propagates: any non-zero rc, empty path, or
  # missing file is a hard FAIL — never an empty-string PASS.
  local rc perms
  set +e
  URL_FILE="$(bash "$DBGUARD" make-url-file "$EXPECTED_DB" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 || -z "$URL_FILE" || ! -f "$URL_FILE" ]]; then
    fail "make-url-file failed (rc=$rc, strict propagation)"
    return 1
  fi
  chmod 600 "$URL_FILE"
  perms="$(stat -c '%a' "$URL_FILE")"
  [[ "$perms" == "600" ]] || { fail "url file perms $perms != 600"; return 1; }
  say "url file: created, private (0600), strict propagation ok"
  say "Gate 1 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 2 — prisma migrate deploy + status on the CMI DB (pinned binary only).
# No db push / db reset / migrate dev / unpinned npx, ever.
# ─────────────────────────────────────────────────────────────────────────────
gate_2_migrate() {
  say "── Gate 2: prisma migrate deploy + status (CMI DB) ──"
  [[ -n "$URL_FILE" && -f "$URL_FILE" ]] || { fail "no usable url file for prisma"; return 1; }
  local log rc
  log="$(mktemp /tmp/monexus-cmi-integration-prisma-XXXXXX)"
  # Secret-safe: on failure report ONLY the phase + exit code. The raw prisma
  # log (may contain connection/DATABASE_URL material) is NEVER tail'd or
  # catted; it is left for the EXIT trap's cleanup.
  set +e
  run_prisma "$URL_FILE" migrate deploy --schema "$SCHEMA" >"$log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail "migrate deploy failed (exit $rc); raw log suppressed, left for cleanup"
    return 1
  fi
  say "migrate deploy: ok"
  set +e
  run_prisma "$URL_FILE" migrate status --schema "$SCHEMA" >"$log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail "migrate status exited non-zero (exit $rc); raw log suppressed, left for cleanup"
    return 1
  fi
  grep -q "Database schema is up to date!" "$log" \
    || { fail "migrate status not up to date (log suppressed, left for cleanup)"; return 1; }
  say "migrate status: up to date"
  rm -f "$log"
  say "Gate 2 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 3 — server runtime + server build (Node 20.19.5 / npm 10 in PATH).
# ─────────────────────────────────────────────────────────────────────────────
gate_3_runtime_build() {
  say "── Gate 3: server runtime + server build ──"
  local rc
  # Secret-safe: on failure report ONLY the phase + exit code. Raw build
  # output is NEVER tail'd into fail; it is left for the EXIT trap's cleanup.
  set +e
  (cd "$SERVER_DIR" && npm run check:runtime) >/tmp/monexus-cmi-integration-rt.$$ 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail "server runtime check failed (exit $rc); output suppressed, left for cleanup"
    return 1
  fi
  rm -f /tmp/monexus-cmi-integration-rt.$$
  say "server runtime: ok"
  set +e
  (cd "$SERVER_DIR" && npm run build) >/tmp/monexus-cmi-integration-build.$$ 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail "server build failed (exit $rc); output suppressed, left for cleanup"
    return 1
  fi
  rm -f /tmp/monexus-cmi-integration-build.$$
  say "server build: ok"
  say "Gate 3 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 4 — Catalog Operations test suite via server/vitest.config.ts.
# The generated CMI url is passed as BOTH TEST_DATABASE_URL and DATABASE_URL.
# Redis is disabled by default in server/.env and this suite needs no Redis; a
# caller's outer .env may leak REDIS_ENABLED=true into Vitest, so the subprocess
# below pins REDIS_ENABLED=false + REDIS_REQUIRED=false (per-command only, never
# exported globally). No external Redis is started or required.
# Test output is captured to a private /tmp log and never echoed, so an
# InventoryItem `content` / storage object key can never leak from this script.
# ─────────────────────────────────────────────────────────────────────────────
gate_4_tests() {
  say "── Gate 4: catalog-ops test suite (24 files, vitest.config.ts) ──"
  [[ -n "$URL_FILE" && -f "$URL_FILE" ]] || { fail "no usable url file for tests"; return 1; }
  local rc log
  log="$(mktemp /tmp/monexus-cmi-integration-vitest-XXXXXX)"
  set +e
  (cd "$SERVER_DIR" \
     && TEST_DATABASE_URL="$(cat "$URL_FILE")" DATABASE_URL="$(cat "$URL_FILE")" \
        REDIS_ENABLED=false REDIS_REQUIRED=false \
        "$VITEST_BIN" run --config "$VITEST_CONFIG" "${TEST_FILES[@]}" >"$log" 2>&1)
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    # Leak-safety: the raw log is NEVER printed (it may contain InventoryItem
    # content / object keys); only the exit code is reported. The log is left
    # for the EXIT trap's cleanup.
    fail "catalog-ops test suite exited $rc (output suppressed to avoid leaking inventory content/object keys)"
    return 1
  fi
  # Leak-safety: the success message does NOT echo raw log lines either.
  rm -f "$log"
  say "test suite passed (raw log not echoed to avoid leaking inventory content/object keys)"
  say "Gate 4 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 5 — scope gate: relative to the current HEAD, the working tree / index
# must be CLEAN or contain ONLY this script. Any other changed / untracked
# path fails the gate.
# ─────────────────────────────────────────────────────────────────────────────
gate_5_scope() {
  say "── Gate 5: scope — relative to HEAD clean or only $SELF_REL ──"
  local extra
  # status --porcelain --untracked-files=all lists every changed/untracked path
  # (including files inside untracked dirs). A clean tree yields zero lines, so
  # the awk/sort pipeline exits 0 and pipefail cannot mis-fail a clean run.
  extra="$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=all 2>/dev/null \
    | awk '{ sub(/^.. /, ""); print }' | sort -u)"
  if [[ -n "$extra" && "$extra" != "$SELF_REL" ]]; then
    fail "working tree / index relative to HEAD is not clean or only $SELF_REL (found: $(printf '%s' "$extra" | tr '\n' ' '))"
    return 1
  fi
  if [[ -z "$extra" ]]; then
    say "scope ok: clean tree relative to HEAD"
  else
    say "scope ok: only $SELF_REL differs from HEAD"
  fi
  say "Gate 5 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 6 — final cleanup verification: CMI DB dropped and no /tmp residue.
# ─────────────────────────────────────────────────────────────────────────────
gate_6_cleanup() {
  say "── Gate 6: cleanup verification (CMI DB + /tmp) ──"
  cleanup
  local leftovers rc
  leftovers="$(find /tmp -maxdepth 1 -name 'monexus-cmi-integration-*' 2>/dev/null | wc -l | tr -d '[:space:]')"
  [[ "$leftovers" == "0" ]] || { fail "leftover /tmp/monexus-cmi-integration-* entries: $leftovers"; return 1; }
  say "/tmp/monexus-cmi-integration-* leftovers: 0"
  # The CMI DB must no longer exist: current-db must FAIL to connect.
  set +e
  bash "$DBGUARD" current-db "$EXPECTED_DB" >/dev/null 2>&1
  rc=$?
  set -e
  [[ "$rc" -ne 0 ]] || { fail "CMI disposable database still exists after cleanup"; return 1; }
  say "CMI disposable database dropped (connection refused)"
  say "Gate 6 PASS"
  return 0
}

gate_summary() {
  local head
  head="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  say "════════════════════════════════════════════════════════════"
  say "verify-catalog-ops-backend complete: PASSED=$PASSED FAILED=$FAILED"
  say "current HEAD: $head"
  say "total duration: ${ELAPSED:-0}s"
  if [[ "$FAILED" -gt 0 ]]; then
    say "failed gates: ${FAILED_GATES[*]}"
  fi
  say "════════════════════════════════════════════════════════════"
  [[ "$FAILED" -eq 0 ]]
}

main() {
  START_TS="$(date +%s)"
  say "verify-catalog-ops-backend start (worktree $(git -C "$PROJECT_ROOT" rev-parse --show-toplevel))"

  # Fail-fast: any gate failure stops the run immediately (run_gate returns
  # non-zero, main returns non-zero, EXIT trap still cleans up).
  run_gate "0_env"           gate_0_env           || return 1
  run_gate "1_db_lifecycle"  gate_1_db_lifecycle  || return 1
  run_gate "2_migrate"       gate_2_migrate       || return 1
  run_gate "3_runtime_build" gate_3_runtime_build || return 1
  run_gate "4_tests"         gate_4_tests         || return 1
  run_gate "5_scope"         gate_5_scope         || return 1

  # Explicit cleanup verification runs ONLY on the all-success path; on any
  # failure above, the EXIT trap still performs cleanup.
  run_gate "6_cleanup"       gate_6_cleanup       || return 1

  ELAPSED=$(( $(date +%s) - START_TS ))
  gate_summary
}

main "$@"
