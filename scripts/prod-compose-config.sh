#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

env_file="${ENV_FILE:-$ROOT_DIR/.env}"
explicit_env_file="false"
project_name="${COMPOSE_PROJECT_NAME:-monexus-prod}"

usage() {
  cat <<'EOF'
Usage: scripts/prod-compose-config.sh [--env-file PATH] [--project-name NAME]

Renders docker-compose.prod.yml with the selected env file.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      env_file="${2:-}"
      explicit_env_file="true"
      shift 2
      ;;
    --project-name)
      project_name="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$env_file" && "$explicit_env_file" == "true" ]]; then
  echo "[ERROR] Env file not found: $env_file" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  env_file="$ROOT_DIR/.env.example"
  echo "[WARN] .env not found; rendering compose config with .env.example placeholders." >&2
fi

docker compose --project-name "$project_name" --env-file "$env_file" -f "$ROOT_DIR/docker-compose.prod.yml" config
