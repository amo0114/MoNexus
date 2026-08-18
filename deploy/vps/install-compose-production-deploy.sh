#!/usr/bin/env bash
# Install or update the root-owned Compose production deployment endpoint.
# Run this from a reviewed repository checkout as root, passing a public
# ED25519 key file for the dedicated GitHub Actions deploy identity.

set -Eeuo pipefail
IFS=$'\n\t'

readonly DEPLOY_USER='monexus-deploy'
readonly DEPLOY_HOME="/home/${DEPLOY_USER}"
readonly DEPLOY_ENTRYPOINT='/usr/local/sbin/monexus-compose-deploy'
readonly SSH_WRAPPER='/usr/local/sbin/monexus-compose-deploy-ssh-wrapper'
readonly SUDOERS_FILE="/etc/sudoers.d/${DEPLOY_USER}"

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/vps/install-compose-production-deploy.sh <deploy-public-key-file>

The key must be a one-line ssh-ed25519 public key. The installer creates a
locked, non-Docker monexus-deploy account with a forced SSH command and grants
sudo permission only for /usr/local/sbin/monexus-compose-deploy.
USAGE
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail 'Run this installer as root.'
}

main() {
  [[ "$#" -eq 1 ]] || { usage >&2; exit 64; }
  require_root

  local key_file="$1"
  local script_dir key_line key_blob authorized_keys authorized_keys_temp actual_home sudoers_temp
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  [[ -f "$key_file" ]] || fail "Public key file is missing: ${key_file}"
  [[ -f "${script_dir}/monexus-compose-deploy" ]] || fail 'Deployment entry point source is missing.'
  [[ -f "${script_dir}/monexus-compose-deploy-ssh-wrapper" ]] || fail 'SSH wrapper source is missing.'
  command -v ssh-keygen >/dev/null 2>&1 || fail 'ssh-keygen is required to validate the public key.'
  command -v visudo >/dev/null 2>&1 || fail 'visudo is required to validate sudoers.'
  command -v getent >/dev/null 2>&1 || fail 'getent is required to validate the dedicated account.'
  command -v gpasswd >/dev/null 2>&1 || fail 'gpasswd is required to enforce the non-Docker account boundary.'

  [[ "$(awk 'END { print NR }' "$key_file")" == '1' ]] || fail 'Public key file must contain exactly one line.'
  key_line="$(awk 'NR == 1 { print }' "$key_file")"
  [[ "$key_line" == ssh-ed25519\ * ]] || fail 'Only ssh-ed25519 public keys are accepted.'
  ssh-keygen -lf "$key_file" >/dev/null
  key_blob="$(awk 'NR == 1 { print $2 }' "$key_file")"
  [[ "$key_blob" =~ ^AAAAC3NzaC1lZDI1NTE5AAAA ]] || fail 'Public key payload is not an ED25519 key.'

  if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --user-group --shell /bin/bash --comment 'MoNexus GitHub Actions deploy' "$DEPLOY_USER"
  fi
  usermod --lock "$DEPLOY_USER"

  actual_home="$(getent passwd "$DEPLOY_USER" | awk -F: 'NR == 1 { print $6 }')"
  [[ "$actual_home" == "$DEPLOY_HOME" ]] || \
    fail "${DEPLOY_USER} must use the dedicated home directory ${DEPLOY_HOME}."

  # Docker-group membership grants effective root access to the daemon. The
  # account may predate this installer, so remove any supplementary membership
  # rather than merely documenting the intended boundary.
  if [[ "$(id -gn "$DEPLOY_USER")" == 'docker' ]]; then
    fail "${DEPLOY_USER} has docker as its primary group; create a dedicated non-Docker account before installing."
  fi
  if getent group docker >/dev/null 2>&1 && id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -Fxq docker; then
    gpasswd -d "$DEPLOY_USER" docker >/dev/null
  fi
  if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -Fxq docker; then
    fail "Unable to remove ${DEPLOY_USER} from the docker group."
  fi

  # This account is only a forced-command transport, so it has no legitimate
  # need to modify its home or authorized keys. Root ownership prevents an
  # unexpected pre-existing login from replacing the constrained key policy.
  # sshd reads AuthorizedKeysFile after dropping to the target account on
  # this host, so give that account's private group only traversal of .ssh and
  # read access to its public authorization. Neither permission permits a
  # policy change; root retains ownership and all write permission.
  install -d -m 0755 -o root -g root "$DEPLOY_HOME"
  install -d -m 0710 -o root -g "$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"
  authorized_keys="${DEPLOY_HOME}/.ssh/authorized_keys"
  [[ ! -e "$authorized_keys" || ( -f "$authorized_keys" && ! -L "$authorized_keys" ) ]] || \
    fail "${authorized_keys} must be a regular, non-symlink file."

  install -m 0755 -o root -g root "${script_dir}/monexus-compose-deploy" "$DEPLOY_ENTRYPOINT"
  install -m 0755 -o root -g root "${script_dir}/monexus-compose-deploy-ssh-wrapper" "$SSH_WRAPPER"
  install -d -m 0755 -o root -g root /opt/monexus-releases
  install -d -m 0700 -o root -g root /opt/monexus-deployments

  sudoers_temp="$(mktemp "${SUDOERS_FILE}.XXXXXX")"
  printf '%s ALL=(root) NOPASSWD: %s\n' "$DEPLOY_USER" "$DEPLOY_ENTRYPOINT" > "$sudoers_temp"
  chmod 0440 "$sudoers_temp"
  visudo -cf "$sudoers_temp" >/dev/null
  mv -f "$sudoers_temp" "$SUDOERS_FILE"

  # Replace, rather than append, the authorization so installs are idempotent
  # and key rotation cannot leave an older deploy key usable.
  authorized_keys_temp="$(mktemp "${DEPLOY_HOME}/.ssh/authorized_keys.XXXXXX")"
  printf 'restrict,command="%s" %s\n' "$SSH_WRAPPER" "$key_line" > "$authorized_keys_temp"
  chown root:"$DEPLOY_USER" "$authorized_keys_temp"
  chmod 0640 "$authorized_keys_temp"
  mv -f "$authorized_keys_temp" "$authorized_keys"

  echo "[PASS] Installed restricted ${DEPLOY_USER} deployment identity."
  echo "[PASS] SSH accepts only dry-run/deploy with a 40-character SHA or the fixed alert rehearsal through the root-owned entry point."
}

main "$@"
