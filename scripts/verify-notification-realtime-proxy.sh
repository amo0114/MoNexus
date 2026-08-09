#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-INF-001) — proxy smoke for the exact SSE stream location.
#
# Proves against the production Nginx (and optional Caddy overlay) that:
#  - /api/notifications/stream is NOT swallowed by the ordinary 60s /api location;
#  - a small raw SSE event / heartbeat arrives immediately (no buffering, no 60s);
#  - response headers carry Content-Type / Cache-Control / X-Accel-Buffering=no;
#  - a synthetic bearer sentinel is rejected and never echoed in the response
#    or optional metrics surface. Deployed Nginx/Caddy/app log inspection is a
#    separate release gate unless explicit external log evidence is supplied.
#
# Usage:
#   NOTIFICATION_REALTIME_PROXY_BASE=https://<site> \
#   NOTIFICATION_REALTIME_PROXY_TOKEN=<out-of-band-token> \
#     bash scripts/verify-notification-realtime-proxy.sh
#
# Requires curl -N and a token obtained OUT OF BAND (never put it in a URL).
set -euo pipefail

READY_ELAPSED_MS=""
wait_for_ready_marker() {
  local body_path="$1"
  local process_pid="$2"
  local deadline_ms="$3"
  local started_ns="$4"
  local now_ns elapsed_ms
  READY_ELAPSED_MS=""
  while true; do
    if grep -q "stream.ready" "$body_path" 2>/dev/null; then
      now_ns="$(date +%s%N)"
      elapsed_ms="$(( (now_ns - started_ns) / 1000000 ))"
      if (( elapsed_ms <= deadline_ms )); then
        READY_ELAPSED_MS="$elapsed_ms"
        return 0
      fi
      return 1
    fi
    now_ns="$(date +%s%N)"
    if (( (now_ns - started_ns) / 1000000 >= deadline_ms )); then return 1; fi
    if ! kill -0 "$process_pid" 2>/dev/null; then return 1; fi
    sleep 0.025
  done
}

if [[ "${1:-}" == "--self-test" ]]; then
  marker_file="$(mktemp)"
  missing_file="$(mktemp)"
  trap 'rm -f "$marker_file" "$missing_file"' EXIT
  (sleep 0.05; printf 'event: stream.ready\n\n' >"$marker_file") &
  marker_pid="$!"
  marker_started="$(date +%s%N)"
  wait_for_ready_marker "$marker_file" "$marker_pid" 500 "$marker_started" || exit 1
  wait "$marker_pid"
  [[ -n "$READY_ELAPSED_MS" ]] || exit 1
  (sleep 0.05) &
  missing_pid="$!"
  missing_started="$(date +%s%N)"
  if wait_for_ready_marker "$missing_file" "$missing_pid" 500 "$missing_started"; then exit 1; fi
  wait "$missing_pid"
  echo '[PASS] proxy marker timing self-test'
  exit 0
fi

BASE="${NOTIFICATION_REALTIME_PROXY_BASE:?NOTIFICATION_REALTIME_PROXY_BASE is required}"
TOKEN="${NOTIFICATION_REALTIME_PROXY_TOKEN:?NOTIFICATION_REALTIME_PROXY_TOKEN is required}"
SENTINEL="${NOTIFICATION_REALTIME_PROXY_SENTINEL:-rt-proxy-sentinel-$(date +%s)-${RANDOM}}"
[[ "$SENTINEL" =~ ^rt-proxy-sentinel-[A-Za-z0-9._-]+$ ]] || {
  echo '[FAIL] invalid proxy sentinel format' >&2
  exit 1
}

fail() { echo "[FAIL] $*" >&2; exit 1; }
pass() { echo "[PASS] $*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

require_cmd curl

# 1. Raw SSE stream via the exact location: headers + first bytes within 2s.
echo "[INFO] Opening deployed SSE stream"
headers_file="$(mktemp)"
body_file="$(mktemp)"
sentinel_body_file="$(mktemp)"
curl_pid=""
cleanup() {
  if [[ -n "$curl_pid" ]] && kill -0 "$curl_pid" 2>/dev/null; then
    kill "$curl_pid" 2>/dev/null || true
    wait "$curl_pid" 2>/dev/null || true
  fi
  rm -f "$headers_file" "$body_file" "$sentinel_body_file"
}
trap cleanup EXIT

# curl -N disables client buffering. The script measures the marker's actual
# arrival and owns/kills only this recorded curl PID at the 2s deadline.
started_ns="$(date +%s%N)"
curl -sN --max-time 10 \
  -D "$headers_file" \
  -H "Accept: text/event-stream" \
  -H "Cache-Control: no-cache" \
  -H "Authorization: Bearer ${TOKEN}" \
  -o "$body_file" \
  "${BASE}/api/notifications/stream" 2>/dev/null &
curl_pid="$!"

wait_for_ready_marker "$body_file" "$curl_pid" 2000 "$started_ns" || true
ready_elapsed_ms="$READY_ELAPSED_MS"

if kill -0 "$curl_pid" 2>/dev/null; then kill "$curl_pid" 2>/dev/null || true; fi
wait "$curl_pid" 2>/dev/null || true
curl_pid=""

grep -qi "^HTTP/.* 200" "$headers_file" || fail "stream did not return 200"
grep -qi "content-type: text/event-stream" "$headers_file" || fail "missing Content-Type: text/event-stream"
grep -qi "cache-control: no-cache, no-transform" "$headers_file" || fail "missing Cache-Control: no-cache, no-transform"
grep -qi "x-accel-buffering: no" "$headers_file" || fail "missing X-Accel-Buffering: no"
grep -q "stream.ready" "$body_file" || fail "no stream.ready in first bytes (buffered?)"
[[ -n "$ready_elapsed_ms" ]] || fail "stream.ready arrival time was not captured"
(( ready_elapsed_ms <= 2000 )) || fail "stream.ready did not arrive within 2s"
if grep -Fq "$TOKEN" "$headers_file" "$body_file"; then fail "bearer token was echoed in the stream response"; fi
pass "raw stream: 200 + headers + stream.ready body bytes arrived in ${ready_elapsed_ms}ms"

# 2. Nginx config test (bundled image) is exercised by npm run check:nginx.

# 3. Sentinel must be rejected on the deployed path and never echoed back.
echo "[INFO] Sending synthetic bearer sentinel; asserting it is rejected and not echoed"
status="$(curl -s --max-time 5 -o "$sentinel_body_file" -w '%{http_code}' \
  -H "Authorization: Bearer ${SENTINEL}" \
  "${BASE}/api/notifications/stream" || true)"
[[ "$status" == "401" ]] || fail "deployed stream auth did not reject sentinel with 401 (status=${status})"
grep -Fq "$SENTINEL" "$sentinel_body_file" && fail "sentinel was echoed in the 401 response"
pass "synthetic bearer is rejected with 401 and not echoed"

# 4. Assert the sentinel is absent from the health/metrics surface (no echo).
if [[ -n "${METRICS_TOKEN:-}" ]]; then
  metrics="$(curl -s --max-time 5 -H "Authorization: Bearer ${METRICS_TOKEN}" "${BASE}/api/metrics" || true)"
  if echo "$metrics" | grep -q "$SENTINEL"; then
    fail "sentinel leaked into /api/metrics"
  fi
  pass "sentinel absent from metrics"
fi

echo "[PASS] notification realtime proxy transport/response smoke completed"
echo "[PENDING] deployed Nginx/Caddy/app log leak inspection requires external log-query evidence"
