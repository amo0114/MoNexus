#!/usr/bin/env bash
# Secret-safe database guard for the PAR-CMI-001 Cross-spec Integration lane.
# The only database this script can create/connect/drop is the disposable
# `monexus_test_catalog_merch_integration` database frozen in PAR-CMI-001 §2.

set +x
set -euo pipefail
umask 077

EXPECTED_DB='monexus_test_catalog_merch_integration'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMMON_GIT_DIR="$(git -C "$WORKTREE_ROOT" rev-parse --git-common-dir)"
if [[ "$COMMON_GIT_DIR" = /* ]]; then
  CANONICAL_ROOT="$(cd "$COMMON_GIT_DIR/.." && pwd)"
else
  CANONICAL_ROOT="$(cd "$WORKTREE_ROOT/$COMMON_GIT_DIR/.." && pwd)"
fi
SERVER_ENV="$CANONICAL_ROOT/server/.env"

fail() { echo "[cmi-dbguard] $*" >&2; exit 1; }
[[ "${2:-$EXPECTED_DB}" == "$EXPECTED_DB" ]] || fail "refusing non-CMI database"

BASE_URL="${DATABASE_URL:-}"
if [[ -z "$BASE_URL" && -f "$SERVER_ENV" ]]; then
  BASE_URL="$(grep -E '^DATABASE_URL=' "$SERVER_ENV" | head -1 | cut -d= -f2- | tr -d '"')"
fi
[[ -n "$BASE_URL" ]] || fail 'DATABASE_URL unavailable'

if [[ "$BASE_URL" =~ ^(postgres|postgresql)://([^:]+):([^@]+)@([^/:]+)(:([0-9]+))?/([^/?]+)(\?[^#]*)?(#.*)?$ ]]; then
  PG_USER="${BASH_REMATCH[2]}"
  PG_PASS="${BASH_REMATCH[3]}"
  PG_HOST="${BASH_REMATCH[4]}"
  PG_PORT="${BASH_REMATCH[6]:-5432}"
else
  fail 'could not parse DATABASE_URL'
fi

export PGPASSWORD="$PG_PASS"

assert_admin() {
  local actual
  actual="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc 'SELECT current_database();' 2>/dev/null | tr -d '[:space:]')"
  [[ "$actual" == 'postgres' ]] || fail "maintenance connection is not postgres"
}

assert_target() {
  local actual
  actual="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$EXPECTED_DB" -tAc 'SELECT current_database();' 2>/dev/null | tr -d '[:space:]')"
  [[ "$actual" == "$EXPECTED_DB" ]] || fail 'connected database does not match CMI target'
}

urlencode() {
  python3 "$WORKTREE_ROOT/scripts/foundation/_urlencode.py" <<<"$1"
}

case "${1:-}" in
  create)
    assert_admin
    exists="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$EXPECTED_DB';" | tr -d '[:space:]')"
    if [[ "$exists" != '1' ]]; then
      psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -tAc "CREATE DATABASE \"$EXPECTED_DB\";" >/dev/null
    fi
    assert_target
    echo '[cmi-dbguard] disposable integration database ready'
    ;;
  current-db)
    assert_target
    echo '[cmi-dbguard] database identity verified'
    ;;
  make-url-file)
    assert_target
    url_file="$(mktemp /tmp/monexus-cmi-integration-XXXXXX)"
    printf 'postgresql://%s:%s@%s:%s/%s' \
      "$PG_USER" "$(urlencode "$PG_PASS")" "$PG_HOST" "$PG_PORT" "$EXPECTED_DB" >"$url_file"
    echo "$url_file"
    ;;
  drop)
    assert_admin
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
      -tAc "DROP DATABASE IF EXISTS \"$EXPECTED_DB\";" >/dev/null
    echo '[cmi-dbguard] disposable integration database dropped'
    ;;
  *)
    fail 'usage: dbguard.sh create|current-db|make-url-file|drop'
    ;;
esac
