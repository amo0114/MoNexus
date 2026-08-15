#!/usr/bin/env bash
set -Eeuo pipefail

# One-time root setup for the narrowly delegated Caddy operations used by the
# protected staging realtime rehearsal. This script changes only one sudoers
# include; it does not install packages or touch application/runtime data.

DEPLOY_USER="${DEPLOY_USER:-monexus-deploy}"
SUDOERS_FILE="/etc/sudoers.d/monexus-staging-caddy"

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

if [[ "$EUID" -ne 0 ]]; then
  fail "Run this setup as root (for example: sudo DEPLOY_USER=$DEPLOY_USER bash $0)."
fi

if ! getent passwd "$DEPLOY_USER" >/dev/null; then
  fail "Deploy user does not exist: $DEPLOY_USER"
fi

command -v visudo >/dev/null 2>&1 || fail "visudo is required to validate sudoers."

sudoers_temp="$(mktemp "${SUDOERS_FILE}.XXXXXX")"
trap 'rm -f "$sudoers_temp"' EXIT

# The install wildcard is limited to the run-scoped temporary Caddy file and
# the one staging include. The remaining commands have fixed arguments.
cat > "$sudoers_temp" <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/install -o root -g root -m 0644 /tmp/monexus-staging.caddy.* /etc/caddy/sites-enabled/monexus-staging.caddy
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/grep -Fqx "    flush_interval -1" /etc/caddy/sites-enabled/monexus-staging.caddy
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/caddy validate --config /etc/caddy/Caddyfile
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
EOF

chmod 0440 "$sudoers_temp"
visudo -cf "$sudoers_temp" >/dev/null
install -o root -g root -m 0440 "$sudoers_temp" "$SUDOERS_FILE"

echo "[PASS] Installed restricted Caddy sudoers rule for $DEPLOY_USER at $SUDOERS_FILE."
