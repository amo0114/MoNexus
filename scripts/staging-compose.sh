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
Usage: scripts/staging-compose.sh {config|build|build-backend|up-backend|build-frontend|up-frontend|up|restart|smoke|ps|logs|down}

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

# Docker bind mounts need an absolute host path. Normalizing here also keeps
# the host-Node and Docker-Node preflight paths identical for local rehearsals.
if [[ "$env_file" == */* ]]; then
  env_dir="${env_file%/*}"
  env_name="${env_file##*/}"
else
  env_dir="."
  env_name="$env_file"
fi
env_file="$(cd "$env_dir" && pwd)/$env_name"

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
  -f "$ROOT_DIR/docker-compose.staging.yml"
  --profile selfhost-storage
  --profile staging-mail
)

preflight() {
  if command -v node >/dev/null 2>&1; then
    bash "$ROOT_DIR/scripts/check-prod-env.sh" \
      --mode staging \
      --env-file "$env_file"
    return
  fi

  # The dedicated staging host needs Docker but not a host-wide Node install.
  # Run the validator in the pinned major-version Node image with no container
  # network. Docker may pull this public base image once when it is absent.
  docker run --rm --network none \
    -v "$ROOT_DIR:$ROOT_DIR:ro" \
    -v "$env_file:$env_file:ro" \
    -w "$ROOT_DIR" \
    node:20-bookworm-slim \
    bash scripts/check-prod-env.sh \
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
  build-backend)
    preflight
    "${compose[@]}" build server
    ;;
  up-backend)
    preflight
    "${compose[@]}" config --no-interpolate >/dev/null
    # Backend-first rollout intentionally leaves the currently served web
    # container untouched. Dependencies must already be healthy in the
    # isolated staging stack; prepare/recovery verifies that precondition.
    "${compose[@]}" up -d --no-deps server
    "${compose[@]}" ps server
    ;;
  build-frontend)
    preflight
    "${compose[@]}" build web
    ;;
  up-frontend)
    preflight
    "${compose[@]}" config --no-interpolate >/dev/null
    "${compose[@]}" up -d --no-deps web
    "${compose[@]}" ps web
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
