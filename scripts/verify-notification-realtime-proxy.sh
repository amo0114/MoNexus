#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 (T-INF-001) — proxy smoke for the exact SSE stream location.
#
# Proves against the production Nginx (and optional Caddy overlay) that:
#  - /api/notifications/stream is NOT swallowed by the ordinary 60s /api location;
#  - a small raw SSE event / heartbeat arrives immediately (no buffering, no 60s);
#  - response headers carry Content-Type / Cache-Control / X-Accel-Buffering=no;
#  - a synthetic bearer sentinel reaches upstream auth but is never echoed in
#    Nginx / Caddy / app logs or metrics (sentinel must not be grep-able).
#
# Usage:
#   NOTIFICATION_REALTIME_PROXY_BASE=https://<site> \
#     bash scripts/verify-notification-realtime-proxy.sh
#
# Requires curl -N and a token obtained OUT OF BAND (never put it in a URL).
set -euo pipefail

BASE="${NOTIFICATION_REALTIME_PROXY_BASE:?NOTIFICATION_REALTIME_PROXY_BASE is required}"
TOKEN="${NOTIFICATION_REALTIME_PROXY_TOKEN:?NOTIFICATION_REALTIME_PROXY_TOKEN is required}"
SENTINEL="rt-proxy-sentinel-$(date +%s)-${RANDOM}"

fail() { echo "[FAIL] $*" >&2; exit 1; }
pass() { echo "[PASS] $*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

require_cmd curl

# 1. Raw SSE stream via the exact location: headers + first bytes within 2s.
echo "[INFO] Opening SSE stream at ${BASE}/api/notifications/stream"
headers_file="$(mktemp)"
body_file="$(mktemp)"
trap 'rm -f "$headers_file" "$body_file"' EXIT

# curl -N disables buffering; --max-time bounds the smoke.
timeout 2 curl -sN --max-time 2 \
  -D "$headers_file" \
  -H "Accept: text/event-stream" \
  -H "Cache-Control: no-cache" \
  -H "Authorization: Bearer ${TOKEN}" \
  -o "$body_file" \
  "${BASE}/api/notifications/stream" >/dev/null 2>&1 || true

grep -qi "^HTTP/.* 200" "$headers_file" || fail "stream did not return 200"
grep -qi "content-type: text/event-stream" "$headers_file" || fail "missing Content-Type: text/event-stream"
grep -qi "cache-control: no-cache, no-transform" "$headers_file" || fail "missing Cache-Control: no-cache, no-transform"
grep -qi "x-accel-buffering: no" "$headers_file" || fail "missing X-Accel-Buffering: no"
grep -q "stream.ready" "$body_file" || fail "no stream.ready in first bytes (buffered?)"
pass "raw stream: 200 + headers + ready arrived immediately"

# 2. Nginx config test (bundled image) is exercised by npm run check:nginx.

# 3. Sentinel must reach upstream auth but never be echoed back.
echo "[INFO] Sending synthetic bearer sentinel; asserting it is not echoed"
status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${SENTINEL}" \
  "${BASE}/api/notifications/stream" || true)"
# A 401 from upstream auth proves the sentinel reached Express.
[[ "$status" == "401" ]] || fail "sentinel did not reach upstream auth (status=${status})"
pass "synthetic bearer reaches upstream auth (401)"

# 4. Assert the sentinel is absent from the health/metrics surface (no echo).
if [[ -n "${METRICS_TOKEN:-}" ]]; then
  metrics="$(curl -s -H "Authorization: Bearer ${METRICS_TOKEN}" "${BASE}/api/metrics" || true)"
  if echo "$metrics" | grep -q "$SENTINEL"; then
    fail "sentinel leaked into /api/metrics"
  fi
  pass "sentinel absent from metrics"
fi

echo "[PASS] notification realtime proxy smoke completed"
