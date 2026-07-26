#!/usr/bin/env bash
set -euo pipefail

# Restore an encrypted MinIO object snapshot into an isolated Compose stack.
# This is intentionally a rehearsal tool, not a production recovery shortcut:
# it refuses ordinary production-looking targets unless the operator supplies
# an explicit emergency override.

BACKUP_OBJECT="${BACKUP_OBJECT:-}"
BACKUP_AGE_IDENTITY_FILE="${BACKUP_AGE_IDENTITY_FILE:-}"
RESTORE_COMPOSE_ENV_FILE="${RESTORE_COMPOSE_ENV_FILE:-}"
RESTORE_COMPOSE_PROJECT_NAME="${RESTORE_COMPOSE_PROJECT_NAME:-}"
CONFIRM_OBJECT_RESTORE="${CONFIRM_OBJECT_RESTORE:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  BACKUP_OBJECT='monexus-objects-....tar.gz.age' \
  BACKUP_AGE_IDENTITY_FILE='/secure/monexus-backup.agekey' \
  RESTORE_COMPOSE_ENV_FILE='/opt/monexus/.env.restore' \
  RESTORE_COMPOSE_PROJECT_NAME='monexus-restore' \
  CONFIRM_OBJECT_RESTORE=RESTORE_OBJECTS \
  scripts/restore-objects-check.sh

Restores an encrypted MinIO bucket snapshot into an already-running isolated
Compose stack. The env-file path and Compose project name must contain
"staging" or "restore" unless ALLOW_PRODUCTION_OBJECT_RESTORE=true is set
for an explicitly approved incident recovery.
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

if [[ "$CONFIRM_OBJECT_RESTORE" != "RESTORE_OBJECTS" ]]; then
  echo "[ERROR] Set CONFIRM_OBJECT_RESTORE=RESTORE_OBJECTS to acknowledge this writes a bucket" >&2
  exit 1
fi

if [[ -z "$BACKUP_OBJECT" || ! -f "$BACKUP_OBJECT" || "$BACKUP_OBJECT" != *.tar.gz.age ]]; then
  echo "[ERROR] BACKUP_OBJECT must point at an existing .tar.gz.age object snapshot" >&2
  exit 1
fi

if [[ -z "$BACKUP_AGE_IDENTITY_FILE" || ! -f "$BACKUP_AGE_IDENTITY_FILE" ]]; then
  echo "[ERROR] BACKUP_AGE_IDENTITY_FILE must point at the matching age identity" >&2
  exit 1
fi

if [[ -z "$RESTORE_COMPOSE_ENV_FILE" || ! -f "$RESTORE_COMPOSE_ENV_FILE" ]]; then
  echo "[ERROR] RESTORE_COMPOSE_ENV_FILE must point at the isolated stack env file" >&2
  exit 1
fi

if [[ -z "$RESTORE_COMPOSE_PROJECT_NAME" ]]; then
  echo "[ERROR] RESTORE_COMPOSE_PROJECT_NAME is required" >&2
  exit 1
fi

if [[ "${ALLOW_PRODUCTION_OBJECT_RESTORE:-false}" != "true" ]]; then
  target_hint="${RESTORE_COMPOSE_ENV_FILE,,} ${RESTORE_COMPOSE_PROJECT_NAME,,}"
  if [[ "$target_hint" != *"staging"* && "$target_hint" != *"restore"* ]]; then
    echo "[ERROR] Object restore target must be clearly staging/restore; refusing: $RESTORE_COMPOSE_PROJECT_NAME" >&2
    echo "        ALLOW_PRODUCTION_OBJECT_RESTORE=true is only for an explicitly approved incident recovery." >&2
    exit 1
  fi
fi

require_cmd age
require_cmd tar
require_cmd docker

object_tmp_dir="$(mktemp -d)"
cleanup() {
  [[ -d "${object_tmp_dir:-}" ]] && rm -rf -- "$object_tmp_dir"
}
trap cleanup EXIT

echo "[INFO] Verifying and decrypting object snapshot"
age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP_OBJECT" | tar -xzf - -C "$object_tmp_dir"

echo "[INFO] Mirroring objects into isolated Compose project: $RESTORE_COMPOSE_PROJECT_NAME"
docker compose \
  --project-name "$RESTORE_COMPOSE_PROJECT_NAME" \
  --env-file "$RESTORE_COMPOSE_ENV_FILE" \
  -f "$repo_root/docker-compose.prod.yml" \
  -f "$repo_root/docker-compose.vps.yml" \
  --profile selfhost-storage \
  run --rm --no-deps --entrypoint /bin/sh \
  -v "$object_tmp_dir:/restore:ro" minio-init \
  -c 'set -eu
      mc alias set restore-target http://minio:9000 "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY"
      mc mb --ignore-existing restore-target/"$STORAGE_BUCKET"
      mc mb --ignore-existing restore-target/"${DELIVERY_STORAGE_BUCKET:-monexus-files}"
      if [ -d /restore/uploads ] || [ -d /restore/delivery ]; then
        # P5 layout: uploads + delivery subdirectories (both buckets).
        if [ -d /restore/uploads ]; then
          mc mirror --quiet --overwrite /restore/uploads restore-target/"$STORAGE_BUCKET"
        fi
        if [ -d /restore/delivery ]; then
          mc mirror --quiet --overwrite /restore/delivery restore-target/"${DELIVERY_STORAGE_BUCKET:-monexus-files}"
        fi
      else
        # Legacy flat archive (uploads only, pre-P5).
        mc mirror --quiet --overwrite /restore restore-target/"$STORAGE_BUCKET"
      fi'

echo "[PASS] Object snapshot restored into isolated bucket"
