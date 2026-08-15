#!/usr/bin/env bash
set -Eeuo pipefail

# One-time root setup for the narrowly delegated Caddy operations used by the
# protected staging realtime rehearsal. This script changes only one sudoers
# include; it does not install packages or touch application/runtime data.

DEPLOY_USER="${DEPLOY_USER:-monexus-deploy}"
SUDOERS_FILE="/etc/sudoers.d/monexus-staging-caddy"
HELPER_FILE="/usr/local/sbin/monexus-staging-caddy-reload"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

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
[[ -f "$SCRIPT_DIR/reload-caddy-site.sh" ]] || fail "Missing Caddy helper: $SCRIPT_DIR/reload-caddy-site.sh"

install -o root -g root -m 0755 "$SCRIPT_DIR/reload-caddy-site.sh" "$HELPER_FILE"

sudoers_temp="$(mktemp "${SUDOERS_FILE}.XXXXXX")"
trap 'rm -f "$sudoers_temp"' EXIT

# The deploy user gets one fixed, root-owned helper and no direct root command
# with user-selected paths or arguments. The helper validates the exact
# reviewed Caddy site before it writes or reloads anything.
cat > "$sudoers_temp" <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: $HELPER_FILE ""
EOF

chmod 0440 "$sudoers_temp"
visudo -cf "$sudoers_temp" >/dev/null
install -o root -g root -m 0440 "$sudoers_temp" "$SUDOERS_FILE"

echo "[PASS] Installed restricted Caddy sudoers rule for $DEPLOY_USER at $SUDOERS_FILE."
