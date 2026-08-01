#!/usr/bin/env bash
set -Eeuo pipefail

# One-time root bootstrap for the dedicated MoNexus staging VPS. This script
# deliberately installs no application code and creates no application secret;
# it only provides Docker, host Caddy, restricted staging directories, and the
# non-root deploy-user access required by scripts/staging-compose.sh.

STAGING_HOST="${STAGING_HOST:-staging.monexus.oai-o.com}"
DEPLOY_USER="${DEPLOY_USER:-monexus-deploy}"
DEPLOY_BASE="/opt/monexus-staging"
STAGING_ENV="/etc/monexus/staging.env"
SITE_DIR="/etc/caddy/sites-enabled"
SITE_FILE="$SITE_DIR/monexus-staging.caddy"
IMPORT_LINE="import /etc/caddy/sites-enabled/*"

usage() {
  cat <<'EOF'
Usage: sudo STAGING_HOST=staging.monexus.oai-o.com bash deploy/staging/bootstrap-host.sh

Optional environment:
  DEPLOY_USER=monexus-deploy   Existing non-root SSH/deploy user

Prerequisites:
  - A dedicated Ubuntu 22.04+ staging VPS
  - Inbound TCP 80/443 allowed by the provider/firewall
  - DNS for STAGING_HOST pointing to this VPS before relying on Caddy TLS
EOF
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$EUID" -ne 0 ]]; then
  fail "Run this bootstrap as root (for example: sudo bash $0)."
fi

if [[ "$STAGING_HOST" != "staging.monexus.oai-o.com" ]]; then
  fail "This dedicated bootstrap only accepts STAGING_HOST=staging.monexus.oai-o.com."
fi

if ! getent passwd "$DEPLOY_USER" >/dev/null; then
  fail "Deploy user does not exist: $DEPLOY_USER"
fi

. /etc/os-release
if [[ "$ID" != "ubuntu" ]]; then
  fail "This bootstrap currently supports Ubuntu hosts only (detected: $ID)."
fi

if command -v ss >/dev/null 2>&1; then
  occupied_ports="$(ss -ltnH | awk '$4 ~ /:(80|443)$/ {print $4}')"
  if [[ -n "$occupied_ports" ]]; then
    # A repeat run sees the Caddy instance this script installed on its first
    # pass. Permit only that known staging site; an nginx/Apache/unknown Caddy
    # listener still stops the script before it can alter host configuration.
    if systemctl is-active --quiet caddy \
      && [[ -f "$SITE_FILE" ]] \
      && grep -Fqx "$STAGING_HOST {" "$SITE_FILE"; then
      echo "[INFO] Existing Caddy staging listener detected; continuing idempotent bootstrap."
    else
      echo "$occupied_ports" >&2
      fail "TCP 80 or 443 is already listening; preserve the existing host configuration and investigate before installing Caddy."
    fi
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release apt-transport-https

# Docker's official Ubuntu repository supplies current Engine, Buildx, and
# Compose v2 on both amd64 and arm64. The key is installed in a dedicated
# keyring and the source is signed-by scoped.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
architecture="$(dpkg --print-architecture)"
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$architecture" "$VERSION_CODENAME" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Caddy is not published for every Ubuntu mirror/architecture combination.
# Use its official signed stable repository; it supplies the caddy systemd
# service and current packages for this ARM64 Ubuntu host.
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

systemctl enable --now docker
usermod -aG docker "$DEPLOY_USER"

# The deploy workflow owns both releases and the `current` symlink. The parent
# must therefore be deploy-user writable; owning only `releases/` would make a
# successful image build fail at the final atomic symlink switch.
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$DEPLOY_BASE"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$DEPLOY_BASE/releases"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 /etc/monexus
if [[ ! -e "$STAGING_ENV" ]]; then
  install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0600 /dev/null "$STAGING_ENV"
fi

# Keep this site in a dedicated include rather than overwriting Caddy's global
# options or any future unrelated host configuration.
install -d -m 0755 "$SITE_DIR"
cat > "$SITE_FILE" <<EOF
# Managed by MoNexus staging bootstrap. Do not point this at production.
$STAGING_HOST {
  encode zstd gzip
  reverse_proxy 127.0.0.1:18081
}
EOF
chmod 0644 "$SITE_FILE"

if ! grep -Fqx "$IMPORT_LINE" /etc/caddy/Caddyfile; then
  printf '\n# MoNexus staging site includes\n%s\n' "$IMPORT_LINE" >> /etc/caddy/Caddyfile
fi

caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy

echo "[PASS] Host bootstrap completed."
echo "[NEXT] Log out and back in as $DEPLOY_USER so Docker group membership applies."
echo "[NEXT] Populate $STAGING_ENV from .env.staging.example without committing or sharing its values."
echo "[NEXT] Verify DNS and provider firewall allow TCP 80/443 before expecting Caddy TLS."
