#!/usr/bin/env bash
# Fast, side-effect-free contract check for the protected production deploy
# scripts and GitHub Actions workflow. Run this in CI; it never needs a VPS,
# Docker daemon, production environment file, or deployment credentials.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

for script in \
  deploy/vps/monexus-compose-deploy \
  deploy/vps/monexus-compose-deploy-ssh-wrapper \
  deploy/vps/install-compose-production-deploy.sh; do
  bash -n "${ROOT_DIR}/${script}"
done

workflow="${ROOT_DIR}/.github/workflows/compose-production-deploy.yml"
[[ -f "$workflow" ]] || fail 'Compose production workflow is missing.'

if command -v ruby >/dev/null 2>&1; then
  ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$workflow" >/dev/null
fi

for required_fragment in \
  'workflow_run:' \
  'COMPOSE_PRODUCTION_AUTO_DEPLOY_ENABLED' \
  'environment: production' \
  'required_reviewers' \
  'MANUAL_DRY_RUN: ${{ github.event.inputs.dry_run }}' \
  'StrictHostKeyChecking=yes' \
  'DEPLOY_SSH_KNOWN_HOSTS' \
  'deploy ${DEPLOY_COMMIT}'; do
  grep -Fq "$required_fragment" "$workflow" || fail "Workflow is missing required safeguard: ${required_fragment}"
done

entrypoint="${ROOT_DIR}/deploy/vps/monexus-compose-deploy"
for required_fragment in \
  "readonly VPS_PROXY_OVERLAY_KEY='MONEXUS_USE_VPS_PROXY_OVERLAY'" \
  'if use_vps_proxy_overlay; then' \
  "notice 'Using the base Compose port mapping; existing direct WEB_PORT exposure is preserved.'"; do
  grep -Fq "$required_fragment" "$entrypoint" || \
    fail "Deployment entry point is missing the explicit port-mapping safeguard: ${required_fragment}"
done

installer="${ROOT_DIR}/deploy/vps/install-compose-production-deploy.sh"
for required_fragment in \
  'install -d -m 0710 -o root -g "$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"' \
  'chown root:"$DEPLOY_USER" "$authorized_keys_temp"' \
  'chmod 0640 "$authorized_keys_temp"'; do
  grep -Fq "$required_fragment" "$installer" || \
    fail "Deployment installer is missing the SSH authorized_keys read-only access contract: ${required_fragment}"
done

wrapper="${ROOT_DIR}/deploy/vps/monexus-compose-deploy-ssh-wrapper"
for forbidden_command in 'shell' 'deploy abcdef' 'deploy 0123456789012345678901234567890123456789 extra'; do
  if SSH_ORIGINAL_COMMAND="$forbidden_command" "$wrapper" >/dev/null 2>&1; then
    fail "Forced-command wrapper accepted an invalid command: ${forbidden_command}"
  fi
done

echo '[PASS] Compose production deployment contract is syntactically valid and retains its core safeguards.'
