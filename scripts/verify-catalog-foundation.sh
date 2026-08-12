#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CMI-CARD verify-catalog-foundation — single reproducible gate runner for the
# catalog-merch integration card (mechanical re-scope of Foundation gate.sh).
#
# Runs the Foundation gate suite (static/empty/legacy/dirty/constraints/
# storage/secret/cleanup) against REAL PostgreSQL using ONLY the disposable
# guard-allowlisted databases (dbguard.sh enforces the cmi_f0_* set and blocks
# every production/notification name). It must exit 0 for the card's change to
# be valid; any failed gate aborts with a non-zero exit.
#
# Secret safety (hard rules):
#   * `set +x` is forced — an inherited xtrace can never leak secrets.
#   * The base DB URL is resolved at startup in priority order: $DATABASE_URL
#     env, then $TEST_DATABASE_URL env (connection template only — dbguard still
#     creates just the five allowlisted disposable DBs), then server/.env. If
#     none exists the script fails non-zero (never .env.example, never a
#     hardcoded credential). It is exported as DATABASE_URL for dbguard + Prisma
#     static and is NEVER printed/echoed.
#   * The URL is materialised into a private 0600 temp file (make-url-file) and
#     passed to prisma via per-command env, never echoed, never argv, never a
#     script variable that leaves this process.
#   * Every prisma command runs from the server cwd with an explicit absolute
#     --schema path, so Prisma resolves server/.env and the frozen schema.
#   * The repository secret scan (gate 9) only inspects content that THIS CARD
#     ADDS (HEAD → working tree): tracked added lines + full untracked files;
#     never baseline content, so a local dev credential that already exists at
#     HEAD cannot cause a false positive.
#     Output is paths/rules only — never the credential.
#
# No `prisma db push` and no unpinned `npx` are ever used: every prisma call is
# the locally-pinned ./node_modules/.bin/prisma from the lockfile. `migrate dev`
# is never used either (it could prompt/reset); only `migrate deploy` /
# `migrate status` / `migrate diff`.
#
# Databases used (guard-allowlisted disposables, dropped on exit):
#   monexus_test_cmi_f0_empty   fresh-DB deploy/status/drift gate
#   monexus_test_cmi_f0_legacy  legacy-clean upgrade + conservation + constraints
#   monexus_test_cmi_f0_dirty   dirty-duplicate expected-failure gate
#   monexus_test_cmi_f0_shadow  Prisma shadow DB for migrate diff
#   monexus_test_cmi_f0_probe   connectivity/guard probe (created+dropped early)
#
# Scope changes vs Foundation gate.sh (this card only, no other file touched):
#   * gate 0: branch must be feat/catalog-merch-integration; HEAD need not equal
#     FROZEN_HEAD, but FROZEN_HEAD must be an ancestor of HEAD.
#   * gate 7: re-scoped from the F0 owned-file boundary (unreplayable across the
#     integration history) to THIS CARD's working-tree diff, which must contain
#     only scripts/verify-catalog-foundation.sh with no uncommitted
#     schema/migrations edits. The old F0 allowlist is deliberately not reused.
#   * gate 8: ancestry only (FROZEN_HEAD ancestor of HEAD), no HEAD equality.
#   * gate 9: secret scan is scoped to THIS CARD's uncommitted change set — tracked
#     working-tree added lines (HEAD → working tree) plus full untracked files.
#     Committed baseline is never scanned (no FROZEN_HEAD diff), so pre-existing
#     placeholders in earlier commits cannot be misattributed to this card.
# ─────────────────────────────────────────────────────────────────────────────

set +x
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"
FOUNDATION_DIR="$SCRIPT_DIR/foundation"
DBGUARD="$FOUNDATION_DIR/dbguard.sh"

# ── Resolve the base DB URL (never printed). ─────────────────────────────────
# Priority: $DATABASE_URL env → $TEST_DATABASE_URL env (used only as a connection
# template — dbguard still creates just the five allowlisted disposable DBs) →
# server/.env. If none exists, fail loudly and non-zero: .env.example and
# hardcoded credentials are never used. Exported as DATABASE_URL so dbguard.sh
# and static Prisma (validate/generate) resolve it from the environment.
BASE_URL="${DATABASE_URL:-}"
if [[ -z "$BASE_URL" ]]; then
  BASE_URL="${TEST_DATABASE_URL:-}"
fi
if [[ -z "$BASE_URL" && -f "$SERVER_DIR/.env" ]]; then
  BASE_URL="$(grep -E '^DATABASE_URL=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [[ -z "$BASE_URL" ]]; then
  printf '[verify-catalog-foundation] FATAL: no DATABASE_URL / TEST_DATABASE_URL in env and no server/.env\n' >&2
  printf '[verify-catalog-foundation]        a verifying agent must inject DATABASE_URL (never .env.example / hardcoded)\n' >&2
  exit 2
fi
export DATABASE_URL="$BASE_URL"

# Password of the resolved URL, parsed in pure bash for gate 9's credential scan
# only; never printed. Empty when the URL has no password (legal — the scan then
# skips the credential-substring rule and still enforces the inline-URL rule).
BASE_PW=""
if [[ "$BASE_URL" =~ ^(postgres|postgresql)://[^:]+:([^@]+)@ ]]; then
  BASE_PW="${BASH_REMATCH[2]}"
fi

# ── Node 20 / npm 10 (frozen engine floor for F0). ──────────────────────────
NODE20_BIN="${NODE20_BIN:-/root/.nvm/versions/node/v20.19.5/bin}"
export PATH="$NODE20_BIN:$PATH"

PRISMA_BIN="$SERVER_DIR/node_modules/.bin/prisma"
SCHEMA="$SERVER_DIR/prisma/schema.prisma"
MIGRATIONS="$SERVER_DIR/prisma/migrations"

DB_EMPTY="monexus_test_cmi_f0_empty"
DB_LEGACY="monexus_test_cmi_f0_legacy"
DB_DIRTY="monexus_test_cmi_f0_dirty"
DB_SHADOW="monexus_test_cmi_f0_shadow"
DB_PROBE="monexus_test_cmi_f0_probe"
DISPOSABLE_DBS=("$DB_EMPTY" "$DB_LEGACY" "$DB_DIRTY" "$DB_SHADOW" "$DB_PROBE")

F0_MIGRATIONS=(
  "20260809010000_catalog_categories_and_drafts"
  "20260809020000_catalog_backfill_categories"
  "20260809030000_external_catalog_identity"
  "20260809040000_merchandising_governance"
)
# Frozen Foundation baseline, used only by the ancestry gates (0 and 8).
# It is the F0 commit; current HEAD (the integration branch) must have it as an
# ancestor but is NOT required to equal it (later business commits are legal).
FROZEN_HEAD="70517f78cf345d31b5676641f7eb7bdaa76b3bb9"



# ── Output bookkeeping. Every gate's REAL exit is counted by run_gate(). ─────
PASSED=0
FAILED=0
declare -a FAILED_GATES=()

say()  { printf '[verify-catalog-foundation] %s\n' "$*"; }
fail() { say "FAIL: $*"; FAILED_GATES+=("$*"); }

# Run a gate and count its real exit code (an unhandled `set -e` abort inside
# the gate still counts as FAILED because the wrapper observes the exit code).
run_gate() {
  local label="$1"; shift
  local rc=0
  "$@" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    PASSED=$((PASSED+1))
    say "Gate $label -> PASS (exit 0)"
  else
    FAILED=$((FAILED+1))
    FAILED_GATES+=("gate_$label")
    say "Gate $label -> FAIL (exit $rc)"
  fi
  return 0
}

# ── Cleanup (trap + explicit). Idempotent, secret-safe. ─────────────────────
# Drops every allowlisted DB, removes all private /tmp url files and staging
# dirs. Runs on EXIT/INT/TERM via the trap AND explicitly (gate 10).
CLEANED=0
cleanup() {
  [[ "${CLEANED:-0}" == "1" ]] && return 0
  CLEANED=1
  say "cleanup: dropping disposable F0 databases"
  local db
  for db in "${DISPOSABLE_DBS[@]}"; do
    bash "$DBGUARD" drop "$db" >/dev/null 2>&1 || true
  done
  say "cleanup: removing /tmp/monexus-cmi-f0-* (private url files + stage dirs)"
  rm -rf /tmp/monexus-cmi-f0-* 2>/dev/null || true
  rm -rf "${STAGE_DIR:-}" 2>/dev/null || true
  return 0
}
trap cleanup EXIT INT TERM

# ── Helpers. ────────────────────────────────────────────────────────────────
# Run prisma against a specific guarded database URL file. Runs from the server
# cwd (Prisma resolves server/.env as a fallback); DATABASE_URL is exported per
# command, never echoed, never argv.
run_prisma() { # $1 = url-file, rest = prisma args
  local uf="$1"; shift
  (cd "$SERVER_DIR" && DATABASE_URL="$(cat "$uf")" "$PRISMA_BIN" "$@")
}

# Static prisma invocation: run from server cwd so Prisma resolves server/.env
# (used by format --check / validate / generate, which need no disposable DB).
run_prisma_static() { # rest = prisma args
  (cd "$SERVER_DIR" && "$PRISMA_BIN" "$@")
}

# Create a guarded DB and return its url-file path (caller trap/cleans).
make_db() { # $1 = dbname -> echoes url-file path; STRICT: every step's failure
  # is propagated (non-zero return, nothing echoed), so a caller doing
  #   uf="$(make_db "$db")" || return 1
  # can never mistake an empty string for a successful creation.
  local db="$1" uf
  bash "$DBGUARD" create "$db" >/dev/null || return 1
  uf="$(bash "$DBGUARD" make-url-file "$db")" || return 1
  [[ -n "$uf" && -f "$uf" ]] || return 1
  printf '%s\n' "$uf"
}

# A migrate-diff result is clean iff stdout is empty or exactly Prisma's
# standard clean marker. Anything else is an actual SQL diff and is rejected.
diff_is_clean() { # $1 = captured stdout
  local out="$1" trimmed
  [[ -z "$out" ]] && return 0
  trimmed="$(printf '%s' "$out" | sed -e 's/[[:space:]]*$//')"
  [[ "$trimmed" == "No difference detected." ]]
}

# Assert a SQL statement FAILS against a disposable DB (negative constraint
# proof). Captures output in a var — no leftover temp file.
expect_psql_fail() { # $1 = dbname $2 = sql
  local db="$1"; shift
  local rc=0 out
  out="$(bash "$DBGUARD" psql "$db" "$*" 2>&1)" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    fail "expected psql failure but it succeeded: $*"
    printf '%s\n' "$out" >&2 || true
    return 1
  fi
  return 0
}

gate_summary() {
  local head
  head="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  say "════════════════════════════════════════════════════════════"
  say "verify-catalog-foundation complete: PASSED=$PASSED FAILED=$FAILED"
  say "current HEAD: $head"
  say "total duration: ${ELAPSED:-0}s"
  if [[ "$FAILED" -gt 0 ]]; then
    say "failed gates: ${FAILED_GATES[*]}"
  fi
  say "════════════════════════════════════════════════════════════"
  [[ "$FAILED" -eq 0 ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 0 — environment / ancestry / tooling / connectivity probe.
# ─────────────────────────────────────────────────────────────────────────────
gate_0_env() {
  say "── Gate 0: environment, ancestry, tooling ──"
  local node_v npm_v
  node_v="$(node --version)"
  npm_v="$(npm --version)"
  say "node=$node_v npm=$npm_v"
  [[ "$node_v" == "v20.19.5" ]] || { fail "node must be v20.19.5 (got $node_v)"; return 1; }
  [[ "$npm_v" == 10.* ]] || { fail "npm must be 10.x (got $npm_v)"; return 1; }

  [[ -x "$PRISMA_BIN" ]] || { fail "prisma binary not found at $PRISMA_BIN"; return 1; }
  command -v psql >/dev/null || { fail "psql not found"; return 1; }

  local branch head
  branch="$(git -C "$PROJECT_ROOT" branch --show-current)"
  head="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  say "branch=$branch head=$head"
  [[ "$branch" == "feat/catalog-merch-integration" ]] || { fail "wrong branch: $branch"; return 1; }
  if ! git -C "$PROJECT_ROOT" merge-base --is-ancestor "$FROZEN_HEAD" HEAD 2>/dev/null; then
    fail "FROZEN_HEAD is not an ancestor of HEAD"
    return 1
  fi
  say "frozen baseline $FROZEN_HEAD is an ancestor of HEAD"

  # dbguard must refuse the typo'd / non-allowlisted probe name.
  if bash "$DBGUARD" make-url-file moneusx_test_cmi_f0_probe >/dev/null 2>&1; then
    fail "dbguard accepted a non-cmi_f0 name"
    return 1
  fi
  say "dbguard refused the typo'd probe name"

  # Connectivity/guard probe: create + verify + drop the probe DB early.
  # EVERY step must succeed — any failure here is a FAIL, never an empty-string PASS.
  local probe_uf
  probe_uf="$(make_db "$DB_PROBE")" || { fail "probe DB create/verify failed"; return 1; }
  rm -f "$probe_uf"
  bash "$DBGUARD" drop "$DB_PROBE" >/dev/null || { fail "probe DB drop failed"; return 1; }
  say "probe DB created / verified / dropped"
  say "Gate 0 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 1 — prisma format --check / validate / generate under Node 20 (static).
# All run from the server cwd so Prisma resolves server/.env (validate/generate
# need a resolvable DATABASE_URL, not a live connection).
# ─────────────────────────────────────────────────────────────────────────────
gate_1_prisma_static() {
  say "── Gate 1: prisma format --check / validate / generate (server cwd) ──"
  local out
  out="$(run_prisma_static format --check --schema "$SCHEMA" 2>&1)" \
    || { fail "prisma format --check: $out"; return 1; }
  say "format: ok"
  out="$(run_prisma_static validate --schema "$SCHEMA" 2>&1)" \
    || { fail "prisma validate: $out"; return 1; }
  say "validate: ok"
  out="$(run_prisma_static generate --schema "$SCHEMA" 2>&1)" \
    || { fail "prisma generate: $out"; return 1; }
  say "generate: ok"
  say "Gate 1 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 2 — fresh empty DB: migrate deploy + status + drift-free diff.
# ─────────────────────────────────────────────────────────────────────────────
gate_2_empty_deploy() {
  say "── Gate 2: fresh empty DB deploy / status / drift ──"
  local empty_uf shadow_uf diff_out
  empty_uf="$(make_db "$DB_EMPTY")" || return 1
  shadow_uf="$(make_db "$DB_SHADOW")" || return 1
  run_prisma "$empty_uf" migrate deploy --schema "$SCHEMA" \
    >/tmp/monexus-cmi-f0-g2deploy.$$ 2>&1 \
    || { fail "empty migrate deploy failed: $(tail -3 /tmp/monexus-cmi-f0-g2deploy.$$)"; return 1; }
  say "empty deploy: ok"
  run_prisma "$empty_uf" migrate status --schema "$SCHEMA" >/tmp/monexus-cmi-f0-g2status.$$ 2>&1 \
    || { fail "empty migrate status exited non-zero: $(tail -3 /tmp/monexus-cmi-f0-g2status.$$)"; return 1; }
  grep -q "Database schema is up to date!" /tmp/monexus-cmi-f0-g2status.$$ \
    || { fail "empty migrate status not up to date"; cat /tmp/monexus-cmi-f0-g2status.$$ >&2; return 1; }
  say "empty status: up to date"
  diff_out="$(run_prisma "$empty_uf" migrate diff \
      --from-migrations "$MIGRATIONS" \
      --to-schema-datamodel "$SCHEMA" \
      --shadow-database-url "$(cat "$shadow_uf")" 2>/tmp/monexus-cmi-f0-g2diff.$$)" \
    || { fail "empty migrate diff failed: $(tail -3 /tmp/monexus-cmi-f0-g2diff.$$)"; return 1; }
  diff_is_clean "$diff_out" \
    || { fail "empty DB drift: schema/migrations differ:\n$diff_out"; return 1; }
  say "empty drift: none"
  rm -f /tmp/monexus-cmi-f0-g2deploy.$$ /tmp/monexus-cmi-f0-g2status.$$ /tmp/monexus-cmi-f0-g2diff.$$
  say "Gate 2 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Stage a DB at the frozen PRE-F0 migration head (56 migrations) using a
# private copy of the HEAD schema + pre-F0 migrations in /tmp.
# ─────────────────────────────────────────────────────────────────────────────
stage_pre_f0() { # $1 = dbname (creates + stages it) -> echoes url-file path
  local db="$1"
  STAGE_DIR="$(mktemp -d /tmp/monexus-cmi-f0-stage-XXXXXX)"
  git -C "$PROJECT_ROOT" show HEAD:server/prisma/schema.prisma > "$STAGE_DIR/schema.prisma"
  mkdir -p "$STAGE_DIR/migrations"
  local d name uf
  for d in "$MIGRATIONS"/*/; do
    name="$(basename "$d")"
    case "$name" in
      20260809010000_catalog_categories_and_drafts|20260809020000_catalog_backfill_categories|20260809030000_external_catalog_identity|20260809040000_merchandising_governance) ;;
      *) cp -r "$d" "$STAGE_DIR/migrations/" ;;
    esac
  done
  cp "$MIGRATIONS/migration_lock.toml" "$STAGE_DIR/migrations/" 2>/dev/null || true
  uf="$(make_db "$db")" || return 1
  run_prisma "$uf" migrate deploy --schema "$STAGE_DIR/schema.prisma" \
    >/tmp/monexus-cmi-f0-stage.$$ 2>&1 \
    || { fail "pre-F0 staging deploy for $db: $(tail -3 /tmp/monexus-cmi-f0-stage.$$)"; return 1; }
  rm -f /tmp/monexus-cmi-f0-stage.$$
  echo "$uf"
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 3 — legacy-clean upgrade: preflight → F0 deploy → status/drift → verify
# (conservation, statuses, category mappings, publishedAt, empty-type repair,
# canonical SKU, zero merch rows, 8 legal config keys, constraints, FKs).
# ─────────────────────────────────────────────────────────────────────────────
gate_3_legacy_upgrade() {
  say "── Gate 3: legacy-clean upgrade + conservation + drift ──"
  local uf shadow_uf diff_out
  uf="$(stage_pre_f0 "$DB_LEGACY")" || return 1
  bash "$DBGUARD" psql-file "$DB_LEGACY" "$FOUNDATION_DIR/fixtures/legacy-clean.sql" \
    || { fail "loading legacy-clean fixture"; return 1; }
  say "legacy fixture loaded"

  # Read-only preflight report at the PRE-F0 head (must succeed, no mutation).
  bash "$DBGUARD" psql-file "$DB_LEGACY" "$FOUNDATION_DIR/preflight-catalog.sql" \
    || { fail "preflight-catalog.sql failed"; return 1; }
  say "preflight report: ok"

  run_prisma "$uf" migrate deploy --schema "$SCHEMA" \
    || { fail "legacy F0 deploy failed"; return 1; }
  say "legacy F0 deploy: ok"

  run_prisma "$uf" migrate status --schema "$SCHEMA" >/tmp/monexus-cmi-f0-g3status.$$ 2>&1 \
    || { fail "legacy migrate status exited non-zero"; cat /tmp/monexus-cmi-f0-g3status.$$ >&2; return 1; }
  grep -q "Database schema is up to date!" /tmp/monexus-cmi-f0-g3status.$$ \
    || { fail "legacy migrate status not up to date"; cat /tmp/monexus-cmi-f0-g3status.$$ >&2; return 1; }
  say "legacy status: up to date"

  # Replay: deploy again must be a no-op (already applied).
  run_prisma "$uf" migrate deploy --schema "$SCHEMA" >/tmp/monexus-cmi-f0-g3replay.$$ 2>&1 \
    || { fail "legacy replay deploy failed"; cat /tmp/monexus-cmi-f0-g3replay.$$ >&2; return 1; }
  grep -q "No pending migrations" /tmp/monexus-cmi-f0-g3replay.$$ \
    || { fail "replay deploy was not a no-op"; cat /tmp/monexus-cmi-f0-g3replay.$$ >&2; return 1; }
  say "legacy replay: no-op"

  shadow_uf="$(make_db "$DB_SHADOW")" || return 1
  diff_out="$(run_prisma "$uf" migrate diff \
      --from-migrations "$MIGRATIONS" \
      --to-schema-datamodel "$SCHEMA" \
      --shadow-database-url "$(cat "$shadow_uf")" 2>/tmp/monexus-cmi-f0-g3diff.$$)" \
    || { fail "legacy migrate diff failed: $(tail -3 /tmp/monexus-cmi-f0-g3diff.$$)"; return 1; }
  diff_is_clean "$diff_out" \
    || { fail "legacy DB drift after F0:\n$diff_out"; return 1; }
  say "legacy drift: none"

  # Conservation + invariants (hard assertions inside the SQL).
  bash "$DBGUARD" psql-file "$DB_LEGACY" "$FOUNDATION_DIR/verify-foundation.sql" \
    || { fail "verify-foundation.sql assertions failed"; return 1; }
  say "verify-foundation: all hard assertions passed"
  rm -f /tmp/monexus-cmi-f0-g3status.$$ /tmp/monexus-cmi-f0-g3replay.$$ /tmp/monexus-cmi-f0-g3diff.$$
  say "Gate 3 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 4 — dirty duplicate: F0 deploy must fail with the exact guard message
# and MUST NOT silently delete/merge/canonicalise the duplicate rows.
# ─────────────────────────────────────────────────────────────────────────────
gate_4_dirty_blocked() {
  say "── Gate 4: dirty external-SKU duplicate blocks F0 (no silent fix) ──"
  local uf dep_err dep_rc n_offers dup_skus applied_f0 n_idx
  uf="$(stage_pre_f0 "$DB_DIRTY")" || return 1
  bash "$DBGUARD" psql-file "$DB_DIRTY" "$FOUNDATION_DIR/fixtures/legacy-clean.sql" \
    || { fail "loading legacy-clean fixture (dirty)"; return 1; }
  bash "$DBGUARD" psql-file "$DB_DIRTY" "$FOUNDATION_DIR/fixtures/legacy-dirty-external-duplicate.sql" \
    || { fail "loading dirty fixture"; return 1; }
  say "dirty fixture loaded (offers should now be 14)"

  # Expected failure at migration 20260809030000 with the exact guard message.
  set +e
  dep_err="$(run_prisma "$uf" migrate deploy --schema "$SCHEMA" 2>&1)"
  dep_rc=$?
  set -e
  [[ "$dep_rc" -ne 0 ]] || { fail "dirty F0 deploy unexpectedly succeeded"; return 1; }
  echo "$dep_err" | grep -qF "Cannot create Offer external identity unique constraint: normalized duplicate (provider, sku) rows exist." \
    || { fail "dirty deploy failed with unexpected message:\n$dep_err"; return 1; }
  say "dirty deploy: failed with the exact guard message (exit $dep_rc)"

  # No silent fix: both duplicate offers still present, original SKUs intact.
  n_offers="$(bash "$DBGUARD" psql "$DB_DIRTY" 'SELECT count(*) FROM "Offer";' | sed -n 3p | tr -d '[:space:]')"
  [[ "$n_offers" == "14" ]] || { fail "dirty offers: expected 14 (no deletion/merge), got $n_offers"; return 1; }
  dup_skus="$(bash "$DBGUARD" psql "$DB_DIRTY" 'SELECT count(*) FROM "Offer" WHERE "externalIntegration"='"'"'faka_bridge'"'"' AND "externalSku" IN ('"'"'XBOARD-DUP-1'"'"','"'"'  xboard-dup-1 '"'"');' | sed -n 3p | tr -d '[:space:]')"
  [[ "$dup_skus" == "2" ]] || { fail "dirty duplicate SKUs were altered: expected 2 original rows, got $dup_skus"; return 1; }

  # Neither migration 03 nor 04 may be SUCCESSFULLY applied. A failed 03 row
  # legitimately exists in _prisma_migrations with finished_at NULL; only count
  # rows with finished_at IS NOT NULL (truly applied).
  applied_f0="$(bash "$DBGUARD" psql "$DB_DIRTY" "SELECT count(*) FROM _prisma_migrations WHERE (migration_name LIKE '2026080903%' OR migration_name LIKE '2026080904%') AND finished_at IS NOT NULL;" | sed -n 3p | tr -d '[:space:]')"
  [[ "$applied_f0" == "0" ]] || { fail "F0 migration 03/04 recorded as applied after failed deploy: $applied_f0"; return 1; }

  # The failed migration must not have left the unique index behind.
  n_idx="$(bash "$DBGUARD" psql "$DB_DIRTY" "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='Offer' AND indexname='Offer_externalIntegration_externalSku_key';" | sed -n 3p | tr -d '[:space:]')"
  [[ "$n_idx" == "0" ]] || { fail "Offer external unique index exists despite failed deploy: $n_idx"; return 1; }
  say "no silent fix verified: 14 offers, original SKUs, migrations 03/04 unapplied"
  say "Gate 4 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 5 — real constraint enforcement (negative inserts) on the upgraded
# legacy DB: NOT NULL, CHECK status, external-SKU unique, partial unique,
# FK RESTRICT, config range CHECK.
# ─────────────────────────────────────────────────────────────────────────────
gate_5_constraints() {
  say "── Gate 5: real CHECK / FK / partial unique / NOT NULL enforcement ──"
  # NOT NULL: Product.categoryId
  expect_psql_fail "$DB_LEGACY" \
    "INSERT INTO \"Product\" (\"name\",\"type\",\"price\",\"deliveryMode\",\"stockMode\",\"status\") VALUES ('x','网络节点',1,'instant_inventory','limited','draft');" \
    || { fail "Product.categoryId NOT NULL not enforced"; return 1; }
  # CHECK: Product.status must be draft|active|inactive
  expect_psql_fail "$DB_LEGACY" \
    "INSERT INTO \"Product\" (\"name\",\"type\",\"price\",\"deliveryMode\",\"stockMode\",\"status\",\"categoryId\") VALUES ('x','网络节点',1,'instant_inventory','limited','archived',1);" \
    || { fail "Product_status_valid_check not enforced"; return 1; }
  # CHECK: MerchandisingRun terminal state consistency
  expect_psql_fail "$DB_LEGACY" \
    "INSERT INTO \"MerchandisingRun\" (\"id\",\"status\",\"windowStart\",\"windowEnd\",\"windowDays\",\"minSales\",\"topPercent\",\"startedAt\",\"completedAt\") VALUES (gen_random_uuid(),'completed',now(),now()+interval '1 day',30,5,20,now(),NULL);" \
    || { fail "MerchandisingRun_terminal_state_check not enforced"; return 1; }
  # Partial unique: seed one running run, then a second must be rejected
  bash "$DBGUARD" psql "$DB_LEGACY" \
    "INSERT INTO \"MerchandisingRun\" (\"id\",\"status\",\"windowStart\",\"windowEnd\",\"windowDays\",\"minSales\",\"topPercent\",\"startedAt\") VALUES (gen_random_uuid(),'running',now(),now()+interval '1 day',30,5,20,now());" >/dev/null \
    || { fail "could not seed first running MerchandisingRun"; return 1; }
  expect_psql_fail "$DB_LEGACY" \
    "INSERT INTO \"MerchandisingRun\" (\"id\",\"status\",\"windowStart\",\"windowEnd\",\"windowDays\",\"minSales\",\"topPercent\",\"startedAt\") VALUES (gen_random_uuid(),'running',now(),now()+interval '1 day',30,5,20,now());" \
    || { fail "MerchandisingRun_single_running partial unique not enforced"; return 1; }
  # Unique external identity: duplicate (faka_bridge, canonical sku)
  expect_psql_fail "$DB_LEGACY" \
    "INSERT INTO \"Offer\" (\"productId\",\"name\",\"price\",\"status\",\"deliveryMode\",\"stockMode\",\"stock\",\"isDefault\",\"externalIntegration\",\"externalSku\") VALUES (1,'dup',999,'active','manual_service','limited',5,false,'faka_bridge','xboard-sku-a');" \
    || { fail "Offer external unique not enforced"; return 1; }
  # FK RESTRICT: cannot delete a category referenced by products
  expect_psql_fail "$DB_LEGACY" \
    "DELETE FROM \"ProductCategory\" WHERE \"code\" = 'network-node';" \
    || { fail "ProductCategory FK RESTRICT not enforced"; return 1; }
  # SystemConfig range CHECK: out-of-range hotWindowDays must be rejected
  expect_psql_fail "$DB_LEGACY" \
    "UPDATE \"SystemConfig\" SET \"value\" = 99999, \"updatedAt\" = now() WHERE \"key\" = 'hotWindowDays';" \
    || { fail "SystemConfig_merchandising_key_ranges_check not enforced"; return 1; }
  say "Gate 5 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 6 — storage regression: storage/delivery tables keep the frozen HEAD
# column sets after the F0 wave. Whitespace-normalised on BOTH sides.
# ─────────────────────────────────────────────────────────────────────────────
gate_6_storage_regression() {
  say "── Gate 6: storage / delivery table regression (columns vs HEAD) ──"
  local checks=(
    "StorageProviderConfig|id type name status configVersion publicConfig credentialsCiphertext credentialsKeyVersion accessKeyLast4 lastTestAt lastTestOk lastTestSummary verifiedAt activatedAt disabledAt activatedById createdById previousActiveId createdAt updatedAt"
    "StorageRuntime|id activeConfigId configVersion updatedAt"
    "StoredObject|id providerConfigId providerRef bucketRole objectKey size checksum mimeType status source sourceId createdAt updatedAt"
  )
  local entry table expect expect_norm got
  for entry in "${checks[@]}"; do
    table="${entry%%|*}"
    expect="${entry#*|}"
    expect_norm="$(printf '%s' "$expect" | tr -d '[:space:]')"
    got="$(bash "$DBGUARD" psql "$DB_EMPTY" "SELECT string_agg(column_name,' ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$table';" | sed -n 3p | tr -d '[:space:]')"
    [[ "$got" == "$expect_norm" ]] \
      || { fail "storage regression $table: expected [$expect] got [$got]"; return 1; }
  done
  say "storage tables unchanged"
  say "Gate 6 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 7 — card working-tree scope. The F0 feature-free gate's original intent
# was the F0 owned-file boundary; replaying it from FROZEN_HEAD to the current
# integration HEAD would necessarily fail on the legal later business commits.
# Scoped instead to THIS CARD: the working-tree change set must be exactly the
# new scripts/verify-catalog-foundation.sh, with no uncommitted
# schema/migrations edits. The old F0 allowlist is deliberately NOT reused or
# expanded (that would mask historical business commits).
# ─────────────────────────────────────────────────────────────────────────────
gate_7_working_tree_scope() {
  say "── Gate 7: card working-tree scope (only scripts/verify-catalog-foundation.sh) ──"
  local found f m
  # grep -v '^$' returns 1 when the tree is clean (nothing to invert), which under
  # `set -o pipefail` makes this substitution fail and can abort the whole gate.
  # Fold the empty-line filter into awk (NF > 1 => non-empty $2) so a clean tree is
  # a stable success; the pipeline has no grep stage that can trip pipefail.
  found="$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=all | awk 'NF > 1 {print $2}' | sort)"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ "$f" == "scripts/verify-catalog-foundation.sh" ]] \
      || { fail "card working-tree scope violated: unexpected path '$f'"; return 1; }
  done <<<"$found"
  say "working tree contains only: scripts/verify-catalog-foundation.sh"
  # schema/migrations must carry no uncommitted modifications.
  if ! git -C "$PROJECT_ROOT" diff --quiet -- server/prisma/schema.prisma server/prisma/migrations; then
    fail "uncommitted schema/migrations modifications present"
    return 1
  fi
  say "schema/migrations: no uncommitted modifications"
  # Every F0 migration dir still present (baseline sanity).
  for m in "${F0_MIGRATIONS[@]}"; do
    [[ -f "$MIGRATIONS/$m/migration.sql" ]] || { fail "migration missing: $m"; return 1; }
  done
  say "Gate 7 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 8 — FROZEN_HEAD ancestry. The frozen Foundation baseline must be an
# ancestor of the current integration HEAD; HEAD equality is NOT required
# (later business commits are legal on this branch).
# ─────────────────────────────────────────────────────────────────────────────
gate_8_ancestry() {
  say "── Gate 8: FROZEN_HEAD ancestry (ancestor of current HEAD) ──"
  local head
  head="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  say "current HEAD: $head"
  if ! git -C "$PROJECT_ROOT" merge-base --is-ancestor "$FROZEN_HEAD" HEAD 2>/dev/null; then
    fail "FROZEN_HEAD is not an ancestor of HEAD"
    return 1
  fi
  say "frozen baseline $FROZEN_HEAD is an ancestor of HEAD"
  say "Gate 8 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 9 — repository secret scan, HEAD → working-tree added-lines semantics.
#
# The scan inspects ONLY the content THIS CARD adds/modifies relative to the
# current HEAD (the uncommitted change set):
#   * tracked+modified files → their working-tree git-added (+) lines
#   * untracked (new) files   → the whole file (it is all new)
# Committed baseline is never scanned, so placeholder URLs committed by earlier
# cards (e.g. scripts/cmi/dbguard.sh, ranking-lifecycle.test.ts) cannot be
# misattributed to this card. The gate proves the card's change set introduces
# no live credential and no inline postgres URL. Output is limited to paths +
# rule names — the credential is never printed.
# ─────────────────────────────────────────────────────────────────────────────
gate_9_secret_scan() {
  say "── Gate 9: repository secret scan (HEAD→worktree added lines only; credential never leaked) ──"
  # Credential comes from the already-resolved DATABASE_URL (parsed at startup
  # into $BASE_PW), never from server/.env. An empty password (URL without one)
  # is legal and only skips the credential-substring rule below; the inline
  # postgres URL rule still runs for every scanned file.
  local pw="$BASE_PW"

  local changed untracked scanned f added leak
  # This card's uncommitted change set: tracked working-tree added lines
  # (HEAD → working tree) + untracked files (full content).
  changed="$(git -C "$PROJECT_ROOT" diff --name-only HEAD -- || true)"
  untracked="$(git -C "$PROJECT_ROOT" ls-files --others --exclude-standard || true)"
  scanned="$(printf '%s\n%s\n' "$changed" "$untracked" | sed '/^$/d' | sort -u)"

  leak=""
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ -f "$PROJECT_ROOT/$f" ]] || continue
    # No path/content allowlist: the git-derived boundary above (tracked diff
    # HEAD→worktree + non-ignored untracked) is what excludes baseline/vendored
    # content, so no allowlist can mask a real hit.
    # Added content only (baseline never scanned).
    if git -C "$PROJECT_ROOT" cat-file -e "HEAD:$f" 2>/dev/null; then
      added="$(git -C "$PROJECT_ROOT" diff HEAD -- "$f" | grep '^+' | grep -v '^+++' | sed 's/^+//')"
    else
      added="$(cat "$PROJECT_ROOT/$f")"
    fi
    # Full-input grep (no -q): under `set -o pipefail` a `printf | grep -q` that finds
    # a hit early makes the upstream printf get SIGPIPE (141), so the `if` misjudges
    # the hit as a miss and the leak is silently undetected. Capturing grep's output
    # keeps the producer feeding the whole stream (a hit is then a stable true) while
    # the matched lines are only length-tested and never printed - leak carries just
    # the file path + rule label, never the credential.
    if [[ -n "$pw" ]] && [[ -n "$(printf '%s\n' "$added" | grep -F -- "$pw" || true)" ]]; then
      leak="$leak $f[credential]"
    fi
    if [[ -n "$(printf '%s\n' "$added" | grep -E 'postgres(ql)?://[^/[:space:]${}]+:[^@[:space:]${}]+@' || true)" ]]; then
      leak="$leak $f[inline-postgres-url]"
    fi
  done <<<"$scanned"

  [[ -z "$leak" ]] || { fail "card change set (HEAD→worktree) introduces a secret or inline postgres URL in:$leak"; return 1; }
  say "card change set (HEAD→worktree) introduces no credential / inline postgres URL (added-lines scan only)"
  say "Gate 9 PASS"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Gate 10 — cleanup verification: no /tmp/monexus-cmi-f0-* leftovers and no
# allowlisted disposable DB left behind (proves the trap cleaned everything).
# ─────────────────────────────────────────────────────────────────────────────
gate_10_tmp_cleanup() {
  say "── Gate 10: cleanup verification (/tmp + disposable DBs) ──"
  cleanup
  local leftovers
  leftovers="$(find /tmp -maxdepth 1 -name 'monexus-cmi-f0-*' 2>/dev/null | wc -l | tr -d '[:space:]')"
  [[ "$leftovers" == "0" ]] || { fail "leftover /tmp/monexus-cmi-f0-* entries: $leftovers"; return 1; }
  say "/tmp/monexus-cmi-f0-* leftovers: 0"
  local db still
  still=0
  for db in "${DISPOSABLE_DBS[@]}"; do
    if bash "$DBGUARD" exists "$db" >/dev/null 2>&1; then
      say "leftover DB not dropped: $db"
      still=$((still+1))
    fi
  done
  [[ "$still" == "0" ]] || { fail "leftover disposable DBs after cleanup: $still"; return 1; }
  say "all allowlisted disposable DBs dropped"
  say "Gate 10 PASS"
  return 0
}

main() {
  START_TS="$(date +%s)"
  say "verify-catalog-foundation start (worktree $(git -C "$PROJECT_ROOT" rev-parse --show-toplevel))"
  run_gate "0_env"               gate_0_env
  run_gate "1_prisma_static"     gate_1_prisma_static
  run_gate "2_empty_deploy"      gate_2_empty_deploy
  run_gate "3_legacy_upgrade"    gate_3_legacy_upgrade
  run_gate "4_dirty_blocked"     gate_4_dirty_blocked
  run_gate "5_constraints"       gate_5_constraints
  run_gate "6_storage_regression" gate_6_storage_regression
  run_gate "7_working_tree_scope" gate_7_working_tree_scope
  run_gate "8_ancestry"          gate_8_ancestry
  run_gate "9_secret_scan"       gate_9_secret_scan
  run_gate "10_tmp_cleanup"      gate_10_tmp_cleanup
  ELAPSED=$(( $(date +%s) - START_TS ))
  gate_summary
}

main "$@"
