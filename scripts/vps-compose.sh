#!/usr/bin/env bash
set -euo pipefail

# Run the self-hosted, single-domain production stack. This wrapper includes
# the VPS overlay and bundled MinIO profile so the application's nginx
# container remains bound to loopback; the host reverse proxy owns :80/:443.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

action="${1:-up}"
if [[ "$#" -gt 0 ]]; then
  shift
fi
env_file="${ENV_FILE:-$ROOT_DIR/.env}"
project_name="${COMPOSE_PROJECT_NAME:-monexus-prod}"

if [[ ! -f "$env_file" ]]; then
  echo "[ERROR] Environment file not found: $env_file" >&2
  echo "Copy .env.example to .env and follow docs/operations/vps-compose-deployment.md." >&2
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
)

case "$action" in
  config)
    "${compose[@]}" config
    ;;
  pull)
    "${compose[@]}" pull
    ;;
  up)
    "${compose[@]}" pull
    "${compose[@]}" up -d --remove-orphans
    "${compose[@]}" ps
    ;;
  down)
    "${compose[@]}" down
    ;;
  restart)
    "${compose[@]}" up -d --remove-orphans
    "${compose[@]}" ps
    ;;
  ps|logs)
    "${compose[@]}" "$action"
    ;;
  exec)
    if [[ "$#" -lt 2 ]]; then
      echo "Usage: $0 exec SERVICE COMMAND [ARG...]" >&2
      exit 2
    fi
    "${compose[@]}" exec -T "$@"
    ;;
  *)
    echo "Usage: $0 {config|pull|up|restart|ps|logs|exec|down}" >&2
    exit 2
    ;;
esac
