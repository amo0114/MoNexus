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
