#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
SKIP_METRICS="${SKIP_METRICS:-false}"
REQUIRE_METRICS_TOKEN="${REQUIRE_METRICS_TOKEN:-false}"

usage() {
  cat <<'EOF'
Usage: scripts/prod-smoke.sh [--env-file PATH]

Smokes the production compose web entrypoint:
  /api/health/live
  /api/health/ready
  /
  /api/metrics
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] Missing required command: $1" >&2
    exit 1
  fi
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

read_env_value() {
  local key="$1"
  local file="$2"
  local line env_key value

  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" == *=* ]] || continue
    env_key="$(trim "${line%%=*}")"
    [[ "$env_key" == "$key" ]] || continue
    value="$(trim "${line#*=}")"
    value="${value%%#*}"
    value="$(trim "$value")"
    value="$(strip_quotes "$value")"
    printf '%s' "$value"
    return 0
  done < "$file"
}

curl_check() {
  local label="$1"
  local url="$2"
  shift 2
  echo "[INFO] Checking $label: $url"
  curl -fsS "$@" "$url" >/dev/null
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
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

require_cmd curl

if [[ -z "${WEB_PORT:-}" ]]; then
  WEB_PORT="$(read_env_value WEB_PORT "$ENV_FILE")"
fi

if [[ -z "${METRICS_TOKEN:-}" ]]; then
  METRICS_TOKEN="$(read_env_value METRICS_TOKEN "$ENV_FILE")"
fi

BASE_URL="${BASE_URL:-http://localhost:${WEB_PORT:-80}}"
BASE_URL="${BASE_URL%/}"

curl_check "backend liveness" "$BASE_URL/api/health/live"
curl_check "backend readiness" "$BASE_URL/api/health/ready"
curl_check "frontend root" "$BASE_URL/"

if [[ "$SKIP_METRICS" == "true" ]]; then
  echo "[INFO] Skipping metrics smoke because SKIP_METRICS=true"
elif [[ -n "${METRICS_TOKEN:-}" ]]; then
  curl_check "metrics" "$BASE_URL/api/metrics" -H "Authorization: Bearer $METRICS_TOKEN"
elif [[ "$REQUIRE_METRICS_TOKEN" == "true" ]]; then
  echo "[ERROR] METRICS_TOKEN is required when REQUIRE_METRICS_TOKEN=true" >&2
  exit 1
else
  echo "[WARN] METRICS_TOKEN is empty; checking /api/metrics without auth"
  curl_check "metrics" "$BASE_URL/api/metrics"
fi


# --- SPEC-NOTIFY-RT-001 realtime smoke (T-INF-002 / AC-RT-023). ---
# Not silently skipped when realtime is enabled (CHK-REL-005). Requires an
# out-of-band access token in NOTIFICATION_REALTIME_SMOKE_TOKEN.
realtime_enabled="$(read_env_value NOTIFICATION_REALTIME_ENABLED "$ENV_FILE")"
if [[ "$realtime_enabled" == "true" ]]; then
  smoke_token="${NOTIFICATION_REALTIME_SMOKE_TOKEN:-}"
  if [[ -z "$smoke_token" ]]; then
    echo "[ERROR] NOTIFICATION_REALTIME_SMOKE_TOKEN is required when realtime is enabled" >&2
    exit 1
  fi
  # flag-on: stream must reach auth (200 with valid token, 401 with none).
  status_no_token="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/notifications/stream" || true)"
  [[ "$status_no_token" == "401" ]] || { echo "[ERROR] realtime stream auth smoke failed (got $status_no_token)" >&2; exit 1; }
  body_file="$(mktemp)"
  headers_file="$(mktemp)"
  timeout 6 curl -sN --max-time 6 -D "$headers_file"     -H "Accept: text/event-stream" -H "Authorization: Bearer $smoke_token"     -o "$body_file" "$BASE_URL/api/notifications/stream" >/dev/null 2>&1 || true
  grep -q "stream.ready" "$body_file" || { echo "[ERROR] realtime stream ready smoke failed (buffered?)" >&2; exit 1; }
  grep -qi "x-accel-buffering: no" "$headers_file" || { echo "[ERROR] realtime stream headers smoke failed" >&2; exit 1; }
  rm -f "$body_file" "$headers_file"
  echo "[INFO] realtime stream ready + auth + headers smoke passed"
else
  # flag-off: stream must 404 (polling fallback), NOT silently skipped.
  status_off="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/notifications/stream" || true)"
  [[ "$status_off" == "404" ]] || { echo "[ERROR] realtime stream must 404 when flag off (got $status_off)" >&2; exit 1; }
  echo "[INFO] realtime stream 404 (flag off) smoke passed"
fi

echo "[INFO] Production smoke checks passed for $BASE_URL"
