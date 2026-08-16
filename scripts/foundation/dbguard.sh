#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# F0 DB-name guard harness.
#
# Secret-safe:
#   - The base URL and password are read from server/.env; they are NEVER passed
#     as argv and NEVER echoed. The URL is parsed in pure bash (no interpreter
#     argv), and the password is URL-encoded via _urlencode.py over stdin.
#   - `make-url-file <dbname>` has the harness create a private temp file via
#     mktemp under /tmp/monexus-cmi-f0-*, chmod 600 it, write the guarded URL,
#     and print ONLY the non-sensitive file path. No URL is ever echoed.
#   - `set +x` is forced so an inherited xtrace cannot leak exported secrets.
#
# Every destructive/migration command MUST obtain its DATABASE_URL via
# `make-url-file` so the logical DB name used to CREATE the database and the
# one embedded in the URL are always the same parsed value, and the actually
# connected database is verified via `SELECT current_database()` first.
#
# Allowed databases are disposable `monexus_test_cmi_f0_*` databases only;
# the default/production/notification databases are hard-blocked. The typo'd
# `moneusx_*` probe is NOT in the prefix and is refused.
#
# Usage:
#   dbguard.sh make-url-file <dbname>   # create private URL file, print path
#   dbguard.sh create <dbname>          # create the DB if missing (guarded)
#   dbguard.sh drop <dbname>            # drop (guarded, disposable-only names)
#   dbguard.sh psql <dbname> <sql>      # run psql against the guarded DB
#   dbguard.sh current-db <dbname>      # assert current_database() == <dbname>
# ─────────────────────────────────────────────────────────────────────────────

set +x
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_ENV="$PROJECT_ROOT/server/.env"

F0_DB_PREFIX="monexus_test_cmi_f0_"

# Hard blocklist — never allow these even if they accidentally match the prefix.
BLOCKLIST=(
  "monexus"
  "monexus_test"
  "monexus_test_notification_realtime"
  "monexus_test_catalog_merch_foundation"
  "monexus_prod"
  "monexus_staging"
)

# Exactly the disposable databases this F0 wave may create/drop.
DISPOSABLE_DBS=(
  "monexus_test_cmi_f0_empty"
  "monexus_test_cmi_f0_legacy"
  "monexus_test_cmi_f0_dirty"
  "monexus_test_cmi_f0_probe"
  "monexus_test_cmi_f0_shadow"
)

err() { echo "[dbguard] $*" >&2; exit 1; }

# Read base URL from server/.env only (never printed).
BASE_URL="${DATABASE_URL:-}"
if [[ -z "$BASE_URL" && -f "$SERVER_ENV" ]]; then
  BASE_URL="$(grep -E '^DATABASE_URL=' "$SERVER_ENV" | head -1 | cut -d= -f2- | tr -d '"' )"
fi
[[ -n "$BASE_URL" ]] || err "DATABASE_URL not found (env or $SERVER_ENV)"

# Parse the base URL in pure bash — the URL never leaves the shell as argv.
# Supports postgres:// and postgresql://, strictly anchored on both ends.
# The database name is captured and validated; unexpected tails are rejected.
if [[ "$BASE_URL" =~ ^(postgres|postgresql)://([^:]+):([^@]+)@([^/:]+)(:([0-9]+))?/([^/?]+)(\?[^#]*)?(#.*)?$ ]]; then
  PG_USER="${BASH_REMATCH[2]}"
  PG_PASS="${BASH_REMATCH[3]}"
  PG_HOST="${BASH_REMATCH[4]}"
  PG_PORT="${BASH_REMATCH[6]:-5432}"
  PG_BASE_DBNAME="${BASH_REMATCH[7]}"
else
  err "could not parse DATABASE_URL"
fi
[[ "$PG_BASE_DBNAME" =~ ^[A-Za-z0-9_]+$ ]] || err "refusing: DATABASE_URL database name is not a plain identifier"

# URL-encode the password via stdin only (never argv).
PG_PASS_ENC="$(python3 "$PROJECT_ROOT/scripts/foundation/_urlencode.py" <<<"$PG_PASS")"

export PGPASSWORD="$PG_PASS"

guard_db_name() {
  local name="$1"
  [[ "$name" == "$F0_DB_PREFIX"* ]] || err "refusing: '$name' does not start with $F0_DB_PREFIX"
  local extra="${name#"$F0_DB_PREFIX"}"
  [[ -n "$extra" && "$extra" =~ ^[a-z0-9_]+$ ]] || err "refusing: invalid F0 suffix '$extra'"
  local b
  for b in "${BLOCKLIST[@]}"; do
    [[ "$name" == "$b" ]] && err "refusing: '$name' is on the blocklist"
  done
  return 0
}

guard_disposable() {
  local name="$1"
  local d
  for d in "${DISPOSABLE_DBS[@]}"; do
    [[ "$name" == "$d" ]] && return 0
  done
  err "refusing: '$name' is not in the F0 disposable DB set"
}

build_url() {
  local name="$1"
  echo "postgresql://${PG_USER}:${PG_PASS_ENC}@${PG_HOST}:${PG_PORT}/${name}"
}

# Assert the currently connected database is exactly <name>.
assert_connected_db() {
  local name="$1"
  local actual
  actual="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$name" -tAc "SELECT current_database();" 2>/dev/null | tr -d '[:space:]')" \
    || err "could not connect to database '$name' to verify identity"
  [[ "$actual" == "$name" ]] || err "connected database '$actual' != expected '$name'"
  return 0
}

# Assert the maintenance connection is exactly the postgres admin database
# before any CREATE/DROP DATABASE destructive SQL.
assert_admin_connection() {
  local actual
  actual="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc "SELECT current_database();" 2>/dev/null | tr -d '[:space:]')" \
    || err "could not connect to the postgres admin database"
  [[ "$actual" == "postgres" ]] || err "admin connection current_database()='$actual' != 'postgres'"
  return 0
}

subcommand="${1:-}"
case "$subcommand" in
  make-url-file)
    [[ $# -eq 2 ]] || err "usage: dbguard.sh make-url-file <dbname>"
    guard_db_name "$2"
    guard_disposable "$2"
    url="$(build_url "$2")"
    assert_connected_db "$2"
    # Harness-owned private temp file (umask 077 + mktemp -> 0600); caller
    # must trap-remove it (gate runner does).
    url_file="$(mktemp /tmp/monexus-cmi-f0-XXXXXX)"
    printf '%s' "$url" > "$url_file"
    echo "$url_file"
    ;;
  create)
    [[ $# -eq 2 ]] || err "usage: dbguard.sh create <dbname>"
    guard_db_name "$2"
    guard_disposable "$2"
    assert_admin_connection
    exists="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$2';" | tr -d '[:space:]')"
    if [[ "$exists" != "1" ]]; then
      psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -tAc "CREATE DATABASE \"$2\";" >/dev/null
    fi
    assert_connected_db "$2"
    echo "[dbguard] ensured '$2'"
    ;;
  drop)
    [[ $# -eq 2 ]] || err "usage: dbguard.sh drop <dbname>"
    guard_db_name "$2"
    guard_disposable "$2"
    assert_admin_connection
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
      -tAc "DROP DATABASE IF EXISTS \"$2\";" >/dev/null
    echo "[dbguard] dropped '$2'"
    ;;
  psql)
    [[ $# -ge 3 ]] || err "usage: dbguard.sh psql <dbname> <sql>"
    guard_db_name "$2"
    guard_disposable "$2"
    dbname="$2"
    assert_connected_db "$dbname"
    shift 2
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$dbname" -c "$*"
    ;;
  psql-file)
    [[ $# -eq 3 ]] || err "usage: dbguard.sh psql-file <dbname> <sql-file>"
    guard_db_name "$2"
    guard_disposable "$2"
    dbname="$2"
    assert_connected_db "$dbname"
    [[ -f "$3" ]] || err "sql file not found: $3"
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$dbname" -v ON_ERROR_STOP=1 -q -f "$3"
    ;;
  current-db)
    [[ $# -eq 2 ]] || err "usage: dbguard.sh current-db <dbname>"
    guard_db_name "$2"
    guard_disposable "$2"
    assert_connected_db "$2"
    echo "[dbguard] connected database verified: $2"
    ;;
  exists)
    [[ $# -eq 2 ]] || err "usage: dbguard.sh exists <dbname>"
    guard_db_name "$2"
    guard_disposable "$2"
    assert_admin_connection
    n="$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$2';" 2>/dev/null | tr -d '[:space:]')"
    [[ "$n" == "1" ]]
    ;;
  *)
    err "unknown subcommand '$subcommand'"
    ;;
esac
