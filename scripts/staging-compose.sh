#!/usr/bin/env bash
set -euo pipefail

# Operate the dedicated staging Compose stack. This is intentionally separate
# from scripts/vps-compose.sh: it always selects the staging project, private
# environment file, Mailpit profile, and loopback-only VPS overlay.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

action="${1:-up}"
env_file="${ENV_FILE:-$ROOT_DIR/.env.staging.local}"
project_name="${COMPOSE_PROJECT_NAME:-monexus-staging}"

usage() {
  cat <<'EOF'
Usage: scripts/staging-compose.sh {config|build|up|restart|smoke|ps|logs|down}

Environment:
  ENV_FILE             Private staging env file (default: .env.staging.local)
  COMPOSE_PROJECT_NAME Must be monexus-staging (default: monexus-staging)
  BASE_URL             Optional loopback URL for smoke (default uses WEB_PORT)
EOF
}

case "$action" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

if [[ "$project_name" != "monexus-staging" ]]; then
  echo "[ERROR] Refusing non-staging Compose project: $project_name" >&2
  exit 2
fi

if [[ ! -f "$env_file" ]]; then
  echo "[ERROR] Staging environment file not found: $env_file" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[ERROR] Docker Compose v2 is required." >&2
  exit 1
fi

compose=(
  docker compose
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$ROOT_DIR/docker-compose.prod.yml"
  -f "$ROOT_DIR/docker-compose.vps.yml"
  --profile selfhost-storage
  --profile staging-mail
)

preflight() {
  bash "$ROOT_DIR/scripts/check-prod-env.sh" \
    --mode staging \
    --env-file "$env_file"
}

case "$action" in
  config)
    preflight
    # Do not render interpolated values: `docker compose config` would print
    # secrets from the private env file into the terminal or CI logs.
    "${compose[@]}" config --no-interpolate
    ;;
  build)
    preflight
    "${compose[@]}" build
    ;;
  up)
    preflight
    "${compose[@]}" config --no-interpolate >/dev/null
    "${compose[@]}" build
    "${compose[@]}" up -d --remove-orphans
    "${compose[@]}" ps
    ;;
  restart)
    preflight
    "${compose[@]}" up -d --remove-orphans
    "${compose[@]}" ps
    ;;
  smoke)
    preflight
    ENV_FILE="$env_file" \
      REQUIRE_METRICS_TOKEN=true \
      bash "$ROOT_DIR/scripts/prod-smoke.sh" --env-file "$env_file"
    ;;
  ps|logs)
    "${compose[@]}" "$action"
    ;;
  down)
    "${compose[@]}" down
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "[ERROR] Unsupported staging action: $action" >&2
    usage >&2
    exit 2
    ;;
esac
