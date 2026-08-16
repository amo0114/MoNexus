#!/usr/bin/env bash
set -Eeuo pipefail

# Root-owned helper installed on the dedicated staging host. The deploy user
# may invoke this command through one exact sudoers entry, but cannot choose a
# destination, command, or arbitrary Caddy configuration.

readonly SITE_FILE='/etc/caddy/sites-enabled/monexus-staging.caddy'
readonly CADDY_CONFIG='/etc/caddy/Caddyfile'
readonly EXPECTED_SITE_SHA256='098549b97231d26c420b20bf4c92db3d0db3bf1e172a0b91dcb5833c44547db0'

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail 'This helper must run as root.'
[[ "$#" -eq 0 ]] || fail 'This helper does not accept command-line arguments.'

payload="$(/usr/bin/cat)"
[[ -n "$payload" ]] || fail 'Missing base64 Caddy site payload.'
(( ${#payload} <= 16384 )) || fail 'Caddy site payload is unexpectedly large.'
[[ "$payload" =~ ^[A-Za-z0-9+/=]+$ ]] || fail 'Caddy site payload is not strict base64.'

tmp_file="$(mktemp /tmp/monexus-staging.caddy.XXXXXX)"
trap 'rm -f "$tmp_file"' EXIT
/usr/bin/printf '%s' "$payload" | /usr/bin/base64 --decode > "$tmp_file" \
  || fail 'Could not decode the Caddy site payload.'

actual_sha256="$(/usr/bin/sha256sum "$tmp_file")"
actual_sha256="${actual_sha256%% *}"
[[ "$actual_sha256" == "$EXPECTED_SITE_SHA256" ]] \
  || fail 'Caddy site payload does not match the reviewed staging configuration.'

/usr/bin/install -o root -g root -m 0644 "$tmp_file" "$SITE_FILE"
/usr/bin/grep -Fqx '    flush_interval -1' "$SITE_FILE"
/usr/bin/caddy validate --config "$CADDY_CONFIG"
/usr/bin/systemctl reload caddy
