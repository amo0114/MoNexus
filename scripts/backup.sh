#!/usr/bin/env bash
set -euo pipefail

# Create an encrypted, restorable PostgreSQL backup. For the bundled VPS
# stack it can also snapshot the MinIO bucket through the Compose network.
# Only the age recipient (a public key) belongs on the VPS; keep the matching
# identity on an independent recovery system.

umask 077

BACKUP_SOURCE="${BACKUP_SOURCE:-url}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/monexus}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
ALLOW_PLAINTEXT_BACKUP="${ALLOW_PLAINTEXT_BACKUP:-false}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
BACKUP_OBJECT_MODE="${BACKUP_OBJECT_MODE:-none}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
BACKUP_COMPOSE_ENV_FILE="${BACKUP_COMPOSE_ENV_FILE:-$repo_root/.env}"
BACKUP_COMPOSE_PROJECT_NAME="${BACKUP_COMPOSE_PROJECT_NAME:-monexus-prod}"

usage() {
  cat <<'EOF'
Usage:
  # External/reachable PostgreSQL
  DATABASE_URL='postgres://...' BACKUP_AGE_RECIPIENT='age1...' scripts/backup.sh

  # Bundled production Compose stack (Postgres remains private)
  BACKUP_SOURCE=docker-compose BACKUP_AGE_RECIPIENT='age1...' scripts/backup.sh

Optional:
  BACKUP_DIR=/var/backups/monexus            # default shown
  RETENTION_DAYS=30                          # local files only
  RCLONE_REMOTE=offsite-crypt:monexus        # encrypted artifacts copied after creation
  BACKUP_OBJECT_MODE=compose-minio           # snapshot bundled MinIO bucket too
  BACKUP_COMPOSE_ENV_FILE=/opt/monexus/.env  # for docker-compose source/mode
  BACKUP_COMPOSE_PROJECT_NAME=monexus-prod   # matches scripts/vps-compose.sh

The default requires BACKUP_AGE_RECIPIENT. Use ALLOW_PLAINTEXT_BACKUP=true
only for a disposable local recovery drill; it is deliberately not suitable
for production data.
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

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] RETENTION_DAYS must be a non-negative integer (got '$RETENTION_DAYS')" >&2
  exit 1
fi

if [[ "$ALLOW_PLAINTEXT_BACKUP" != "true" && -z "$BACKUP_AGE_RECIPIENT" ]]; then
  echo "[ERROR] BACKUP_AGE_RECIPIENT is required. Refusing to create an unencrypted backup." >&2
  echo "        Set ALLOW_PLAINTEXT_BACKUP=true only for an explicitly disposable local drill." >&2
  exit 1
fi

require_cmd gzip
case "$BACKUP_SOURCE" in
  url) require_cmd pg_dump ;;
  docker-compose) require_cmd docker ;;
  *)
    echo "[ERROR] BACKUP_SOURCE must be url or docker-compose (got '$BACKUP_SOURCE')" >&2
    exit 1
    ;;
esac
if [[ -n "$BACKUP_AGE_RECIPIENT" ]]; then
  require_cmd age
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

dump_database() {
  case "$BACKUP_SOURCE" in
    url)
      local database_url="${DATABASE_URL:-${BACKUP_DATABASE_URL:-}}"
      if [[ -z "$database_url" ]]; then
        echo "[ERROR] DATABASE_URL or BACKUP_DATABASE_URL is required when BACKUP_SOURCE=url" >&2
        return 1
      fi
      # Strip Prisma query params (e.g. ?schema=public) — pg_dump rejects
      # unknown URI params.
      pg_dump "${database_url%%\?*}"
      ;;
    docker-compose)
      require_cmd docker
      if [[ ! -f "$BACKUP_COMPOSE_ENV_FILE" ]]; then
        echo "[ERROR] BACKUP_COMPOSE_ENV_FILE does not exist: $BACKUP_COMPOSE_ENV_FILE" >&2
        return 1
      fi
      # Credentials are expanded inside the already-running Postgres
      # container, so neither the password nor a database URL is emitted by
      # this script or required in its cron environment.
      docker compose \
        --project-name "$BACKUP_COMPOSE_PROJECT_NAME" \
        --env-file "$BACKUP_COMPOSE_ENV_FILE" \
        -f "$repo_root/docker-compose.prod.yml" \
        -f "$repo_root/docker-compose.vps.yml" \
        --profile selfhost-storage \
        exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"'
      ;;
    *)
      echo "[ERROR] BACKUP_SOURCE must be url or docker-compose (got '$BACKUP_SOURCE')" >&2
      return 1
      ;;
  esac
}

create_encrypted_dump() {
  local temp_file="$1"
  if [[ -n "$BACKUP_AGE_RECIPIENT" ]]; then
    dump_database | gzip -c | age -r "$BACKUP_AGE_RECIPIENT" > "$temp_file"
  else
    dump_database | gzip -c > "$temp_file"
  fi
}

copy_offsite() {
  local artifact="$1"
  if [[ -z "$RCLONE_REMOTE" ]]; then
    return 0
  fi
  require_cmd rclone
  echo "[INFO] Copying $(basename "$artifact") to configured offsite remote"
  rclone copy "$artifact" "$RCLONE_REMOTE"
}

if [[ -n "$BACKUP_AGE_RECIPIENT" ]]; then
  backup_file="$BACKUP_DIR/monexus-${timestamp}.sql.gz.age"
else
  backup_file="$BACKUP_DIR/monexus-${timestamp}.sql.gz"
fi
temp_db_file="$(mktemp "$BACKUP_DIR/.monexus-db-${timestamp}.XXXXXX")"
temp_object_file=""
object_tmp_dir=""

cleanup_temporary_files() {
  [[ -n "${temp_db_file:-}" && -f "$temp_db_file" ]] && rm -f -- "$temp_db_file"
  [[ -n "${temp_object_file:-}" && -f "$temp_object_file" ]] && rm -f -- "$temp_object_file"
  if [[ -n "${object_tmp_dir:-}" && -d "$object_tmp_dir" ]]; then
    rm -rf -- "$object_tmp_dir"
  fi
}
trap cleanup_temporary_files EXIT

echo "[INFO] Dumping PostgreSQL (${BACKUP_SOURCE})"
create_encrypted_dump "$temp_db_file"
mv -f -- "$temp_db_file" "$backup_file"
temp_db_file=""
echo "[INFO] Database backup written: $backup_file"
copy_offsite "$backup_file"

object_file=""

case "$BACKUP_OBJECT_MODE" in
  none)
    ;;
  compose-minio)
    if [[ -z "$BACKUP_AGE_RECIPIENT" ]]; then
      echo "[ERROR] BACKUP_OBJECT_MODE=compose-minio requires BACKUP_AGE_RECIPIENT" >&2
      exit 1
    fi
    require_cmd docker
    require_cmd tar
    if [[ ! -f "$BACKUP_COMPOSE_ENV_FILE" ]]; then
      echo "[ERROR] BACKUP_COMPOSE_ENV_FILE does not exist: $BACKUP_COMPOSE_ENV_FILE" >&2
      exit 1
    fi

    object_tmp_dir="$(mktemp -d "$BACKUP_DIR/.monexus-objects-${timestamp}.XXXXXX")"
    object_file="$BACKUP_DIR/monexus-objects-${timestamp}.tar.gz.age"
    temp_object_file="$(mktemp "$BACKUP_DIR/.monexus-objects-${timestamp}.XXXXXX")"
    # P5: the snapshot covers BOTH buckets — the public upload bucket and the
    # private delivery bucket (paid files). Layout: /uploads + /delivery
    # subdirectories; restore-objects-check.sh understands both this layout
    # and the legacy flat (uploads-only) archives.
    echo "[INFO] Mirroring bundled MinIO buckets (uploads + delivery) through the private Compose network"
    docker compose \
      --project-name "$BACKUP_COMPOSE_PROJECT_NAME" \
      --env-file "$BACKUP_COMPOSE_ENV_FILE" \
      -f "$repo_root/docker-compose.prod.yml" \
      -f "$repo_root/docker-compose.vps.yml" \
      --profile selfhost-storage \
      run --rm --no-deps --entrypoint /bin/sh \
      -v "$object_tmp_dir:/backup" minio-init \
      -c 'set -eu
          mc alias set backup-source http://minio:9000 "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY"
          mkdir -p /backup/uploads /backup/delivery
          mc mirror --quiet backup-source/"$STORAGE_BUCKET" /backup/uploads
          mc mirror --quiet backup-source/"${DELIVERY_STORAGE_BUCKET:-monexus-files}" /backup/delivery'

    tar -C "$object_tmp_dir" -czf - . | age -r "$BACKUP_AGE_RECIPIENT" > "$temp_object_file"
    mv -f -- "$temp_object_file" "$object_file"
    temp_object_file=""
    echo "[INFO] MinIO object backup written: $object_file"
    copy_offsite "$object_file"
    cleanup_temporary_files
    object_tmp_dir=""
    ;;
  *)
    echo "[ERROR] BACKUP_OBJECT_MODE must be none or compose-minio (got '$BACKUP_OBJECT_MODE')" >&2
    exit 1
    ;;
esac

echo "[INFO] Pruning local backups older than ${RETENTION_DAYS} days under $BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'monexus-*.sql.gz' -o -name 'monexus-*.sql.gz.age' -o -name 'monexus-objects-*.tar.gz.age' \) \
  -mtime "+${RETENTION_DAYS}" -delete

echo "$backup_file"
if [[ -n "$object_file" ]]; then
  echo "$object_file"
fi
