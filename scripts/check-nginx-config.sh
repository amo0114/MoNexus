#!/usr/bin/env bash
set -euo pipefail

# Static contract check for the reverse-proxy safety headers. Full `nginx -t`
# runs inside the release image in deployment; this keeps the policy covered
# without requiring Docker or a live MinIO endpoint in local/CI checks.

config_file="${1:-nginx.conf}"

if [[ ! -f "$config_file" ]]; then
  echo "[ERROR] Nginx config not found: $config_file" >&2
  exit 1
fi

uploads_block="$(sed -n '/location ~ \^\/uploads/,/^  }/p' "$config_file")"
if [[ -z "$uploads_block" ]]; then
  echo "[ERROR] /uploads reverse-proxy location is missing" >&2
  exit 1
fi

if ! grep -Fq 'add_header X-Content-Type-Options "nosniff" always;' <<< "$uploads_block"; then
  echo "[ERROR] /uploads must set X-Content-Type-Options: nosniff" >&2
  exit 1
fi

echo "[PASS] /uploads MIME-sniffing protection is configured"

index_block="$(sed -n '/location = \/index.html {/,/^  }/p' "$config_file")"
if ! grep -Fq 'add_header Cache-Control "no-cache";' <<< "$index_block"; then
  echo "[ERROR] /index.html must be served with Cache-Control: no-cache" >&2
  exit 1
fi

echo "[PASS] index.html is revalidated on every navigation"

# SEC-03: every location nginx serves itself carries the browser security
# headers; /api locations leave them to helmet so they are not sent twice.
if ! grep -Fq "frame-ancestors 'none'" "$config_file"; then
  echo "[ERROR] Content-Security-Policy must set frame-ancestors 'none'" >&2
  exit 1
fi
for location in 'location \/ {' 'location = \/index.html {' 'location \/assets\/ {' 'location ~ \^\/uploads'; do
  block="$(sed -n "/${location}/,/^  }/p" "$config_file")"
  for header in Content-Security-Policy X-Frame-Options X-Content-Type-Options Referrer-Policy Cross-Origin-Opener-Policy; do
    if ! grep -Fq "add_header ${header} " <<< "$block"; then
      echo "[ERROR] ${location//\\/} must set ${header}" >&2
      exit 1
    fi
  done
done
api_block="$(sed -n '/location \/api\/ {/,/^  }/p' "$config_file")"
if grep -Fq 'Content-Security-Policy' <<< "$api_block"; then
  echo "[ERROR] /api must not repeat helmet's security headers" >&2
  exit 1
fi

echo "[PASS] static locations send the browser security headers"
