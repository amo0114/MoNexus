#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-QA-004) — multi-instance verify (AC-RT-005 / REQ-F-020).
#
# Starts two independent Node backend processes (A=3112 SSE host, B=3113 order
# writer) sharing the dedicated test DB, then runs the harness which opens an
# SSE stream on A and creates an order through B. Verifies A receives the
# notification.created for the order written on B (PostgreSQL LISTEN/NOTIFY,
# not an in-process EventEmitter). Only terminates PIDs recorded here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/server"
ENV_FILE="${RT_ENV_FILE:-$ROOT/.env.notification-realtime.local}"
PORT_A="${RT_MULTI_PORT_A:-3112}"
PORT_B="${RT_MULTI_PORT_B:-3113}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[multi] missing local env file: $ENV_FILE" >&2
  exit 1
fi

set +x
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
true

case "$TEST_DATABASE_URL" in
  */monexus_test_notification_realtime?schema=public) ;;
  *) echo "[multi] TEST_DATABASE_URL must point to monexus_test_notification_realtime" >&2; exit 1 ;;
esac

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${pids[@]:-}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

start_backend() {
  local port="$1"
  local label="$2"
  (
    cd "$SERVER"
    exec env \
      NODE_ENV=test \
      PORT="$port" \
      DATABASE_URL="$TEST_DATABASE_URL" \
      JWT_SECRET="test-secret-key-at-least-32-characters-long!!" \
      FRONTEND_ORIGIN="http://localhost:5173" \
      COOKIE_SECURE=false \
      NOTIFICATION_ENABLED=true \
      NOTIFICATION_REALTIME_ENABLED=true \
      node --import tsx src/main.ts
  ) >"$ROOT/outputs/rt-multi-$label.log" 2>&1 &
  pids+=($!)
  echo "[multi] started backend $label on port $port (pid $!)"
}

mkdir -p "$ROOT/outputs"
start_backend "$PORT_A" "A"
start_backend "$PORT_B" "B"

wait_ready() {
  local port="$1"
  local deadline=$((SECONDS + 30))
  until [[ $SECONDS -gt $deadline ]]; do
    if curl -s "http://127.0.0.1:$port/api/health/ready" 2>/dev/null | grep -q '"notificationRealtime":"ok"'; then
      return 0
    fi
    sleep 1
  done
  echo "[multi] backend on $port did not become realtime-ready" >&2
  return 1
}
wait_ready "$PORT_A"
wait_ready "$PORT_B"

echo "[multi] both backends realtime-ready"

(cd "$SERVER" && env \
  NODE_ENV=test \
  DATABASE_URL="$TEST_DATABASE_URL" \
  JWT_SECRET="test-secret-key-at-least-32-characters-long!!" \
  FRONTEND_ORIGIN="http://localhost:5173" \
  COOKIE_SECURE=false \
  RT_MULTI_PORT_A="$PORT_A" RT_MULTI_PORT_B="$PORT_B" \
  node --import tsx scripts/notification-realtime-multi-instance-harness.mjs)
