#!/usr/bin/env bash
set -euo pipefail

BACKUP="${BACKUP:-}"
RESTORE_TARGET_URL="${RESTORE_TARGET_URL:-}"
PSQL_COMMAND="${PSQL_COMMAND:-psql}"
MIN_USER_ROWS="${MIN_USER_ROWS:-1}"
MIN_POINT_LOG_ROWS="${MIN_POINT_LOG_ROWS:-1}"
BACKUP_AGE_IDENTITY_FILE="${BACKUP_AGE_IDENTITY_FILE:-}"

usage() {
  cat <<'EOF'
Usage:
  RESTORE_TARGET_URL='<staging-db-url>' BACKUP='monexus-backup.sql.gz.age' \
    BACKUP_AGE_IDENTITY_FILE='/secure/monexus-backup.agekey' scripts/restore-check.sh

Restores a SQL backup into a staging database and checks basic row counts.
Never point RESTORE_TARGET_URL at production. Legacy .sql.gz backups remain
readable; .age backups require BACKUP_AGE_IDENTITY_FILE.

Optional:
  PSQL_COMMAND='docker compose exec -T postgres psql'
  MIN_USER_ROWS=1
  MIN_POINT_LOG_ROWS=1
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] Missing required command: $1" >&2
    exit 1
  fi
}

read -r -a psql_parts <<< "$PSQL_COMMAND"

require_cmd "${psql_parts[0]}"
require_cmd gunzip

if [[ -z "$RESTORE_TARGET_URL" ]]; then
  echo "[ERROR] RESTORE_TARGET_URL is required" >&2
  exit 1
fi

if [[ -z "$BACKUP" || ! -f "$BACKUP" ]]; then
  echo "[ERROR] BACKUP must point at an existing .sql.gz or .sql.gz.age file" >&2
  exit 1
fi

if [[ "$RESTORE_TARGET_URL" != *"staging"* && "$RESTORE_TARGET_URL" != *"restore"* && "${ALLOW_PRODUCTION_RESTORE:-false}" != "true" ]]; then
  echo "[ERROR] RESTORE_TARGET_URL must look like a staging/restore database URL." >&2
  echo "        Refusing to restore into: $RESTORE_TARGET_URL" >&2
  echo "        Set ALLOW_PRODUCTION_RESTORE=true only for an explicitly approved recovery drill." >&2
  exit 1
fi

decrypt_backup() {
  if [[ "$BACKUP" == *.age ]]; then
    if [[ -z "$BACKUP_AGE_IDENTITY_FILE" || ! -f "$BACKUP_AGE_IDENTITY_FILE" ]]; then
      echo "[ERROR] BACKUP_AGE_IDENTITY_FILE is required for encrypted backups" >&2
      return 1
    fi
    require_cmd age
    age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP"
  else
    cat "$BACKUP"
  fi
}

echo "[INFO] Verifying backup integrity"
decrypt_backup | gunzip -t

psql_exec() {
  "${psql_parts[@]}" "$RESTORE_TARGET_URL" -v ON_ERROR_STOP=1 "$@"
}

psql_restore() {
  "${psql_parts[@]}" "$RESTORE_TARGET_URL" -v ON_ERROR_STOP=1 >/dev/null
}

echo "[INFO] Resetting target schema"
psql_exec -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

echo "[INFO] Restoring backup into target"
decrypt_backup | gunzip -c | psql_restore

query_count() {
  local table="$1"
  psql_exec -At -c "SELECT COUNT(*) FROM \"$table\";"
}

user_rows="$(query_count User)"
point_log_rows="$(query_count PointLog)"

echo "[INFO] Restored User rows: $user_rows"
echo "[INFO] Restored PointLog rows: $point_log_rows"

if (( user_rows < MIN_USER_ROWS )); then
  echo "[ERROR] User row count $user_rows is below MIN_USER_ROWS=$MIN_USER_ROWS" >&2
  exit 1
fi

if (( point_log_rows < MIN_POINT_LOG_ROWS )); then
  echo "[ERROR] PointLog row count $point_log_rows is below MIN_POINT_LOG_ROWS=$MIN_POINT_LOG_ROWS" >&2
  exit 1
fi

echo "[PASS] Restore rehearsal passed"
