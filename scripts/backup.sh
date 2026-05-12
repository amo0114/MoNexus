#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[ERROR] DATABASE_URL is required (e.g. postgres://user:pass@host:5432/dbname)" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/monexus}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] RETENTION_DAYS must be a non-negative integer (got '$RETENTION_DAYS')" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/monexus-${timestamp}.sql.gz"

echo "[INFO] Dumping database to $backup_file"
# Strip Prisma query params (e.g. ?schema=public) — pg_dump rejects unknown URI params
db_url_for_pg_dump="${DATABASE_URL%%\?*}"
pg_dump "$db_url_for_pg_dump" | gzip -c > "$backup_file"

echo "[INFO] Pruning backups older than ${RETENTION_DAYS} days under $BACKUP_DIR"
find "$BACKUP_DIR" -name 'monexus-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  echo "[INFO] Uploading to remote: $RCLONE_REMOTE"
  rclone copy "$backup_file" "$RCLONE_REMOTE"
fi

echo "$backup_file"
