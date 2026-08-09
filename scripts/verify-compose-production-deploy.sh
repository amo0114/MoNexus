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
  deploy/vps/install-compose-production-deploy.sh \
  scripts/staging-compose.sh \
  scripts/notification-realtime-staging-host.sh \
  scripts/run-notification-realtime-staging-rehearsal.sh; do
  bash -n "${ROOT_DIR}/${script}"
done

node "${ROOT_DIR}/server/scripts/notification-realtime-staging-fixture.mjs" --self-test
node "${ROOT_DIR}/scripts/notification-realtime-staging-collector.mjs" --self-test

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

staging_workflow="${ROOT_DIR}/.github/workflows/staging-deploy.yml"
[[ -f "$staging_workflow" ]] || fail 'Staging Compose workflow is missing.'
if command -v ruby >/dev/null 2>&1; then
  ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$staging_workflow" >/dev/null
fi
for required_fragment in \
  'realtime_rehearsal' \
  'REHEARSE_AND_ROLL_BACK' \
  'environment: staging' \
  'StrictHostKeyChecking=yes' \
  'run-notification-realtime-staging-rehearsal.sh' \
  'notification-realtime-staging-evidence-'; do
  grep -Fq "$required_fragment" "$staging_workflow" || \
    fail "Staging workflow is missing required rehearsal safeguard: ${required_fragment}"
done

for required_fragment in \
  "CONFIRMATION='monexus-staging-notification-realtime'" \
  "BASE_PATH='/opt/monexus-staging'" \
  "PROJECT_NAME='monexus-staging'" \
  'NOTIFICATION_REALTIME_ENABLED false' \
  'frontend-build' \
  'read -r RT_STAGING_FIXTURE_PASSWORD' \
  'recover_run' \
  'manual_intervention_required=true' \
  'fixture-clean'; do
  grep -Fq "$required_fragment" "${ROOT_DIR}/scripts/notification-realtime-staging-host.sh" || \
    fail "Staging host script is missing required recovery boundary: ${required_fragment}"
done

fixture_script="${ROOT_DIR}/server/scripts/notification-realtime-staging-fixture.mjs"
if grep -Eq "jsonwebtoken|accessToken|token:[[:space:]]*sign" "$fixture_script"; then
  fail 'Staging fixture must not sign or emit an access token.'
fi
grep -Fq 'userId: fixture.merchantUser.id' "$fixture_script" || \
  fail 'Staging fixture must emit credential-free merchant identity metadata.'
for required_fragment in \
  "RT_STAGING_COLLECTOR_MODE=token" \
  "RT_STAGING_TOKEN_FILE" \
  "recovery-runner.txt"; do
  grep -Fq "$required_fragment" "${ROOT_DIR}/scripts/run-notification-realtime-staging-rehearsal.sh" || \
    fail "Staging runner is missing private credential/recovery safeguard: ${required_fragment}"
done
grep -Fq 'failure_stage=' "${ROOT_DIR}/scripts/notification-realtime-staging-collector.mjs" || \
  fail 'Staging collector must write aggregate FAIL evidence on incomplete latency runs.'

grep -Fq 'flush_interval -1' "${ROOT_DIR}/deploy/staging/Caddyfile" || \
  fail 'Staging Caddy site must force immediate SSE flushing.'
grep -Fq 'API_RATE_LIMIT_MAX: ${API_RATE_LIMIT_MAX:-300}' "${ROOT_DIR}/docker-compose.prod.yml" || \
  fail 'Compose must explicitly map the existing API rate-limit configuration.'

entrypoint="${ROOT_DIR}/deploy/vps/monexus-compose-deploy"
for required_fragment in \
  "readonly VPS_PROXY_OVERLAY_KEY='MONEXUS_USE_VPS_PROXY_OVERLAY'" \
  'if use_vps_proxy_overlay; then' \
  "notice 'Using the base Compose port mapping; existing direct WEB_PORT exposure is preserved.'" \
  '[[ -f "${release_path}/scripts/check-prod-env.sh" ]] ||' \
  'bash "${release_path}/scripts/check-prod-env.sh" --mode production --env-file "$ENV_FILE"'; do
  grep -Fq "$required_fragment" "$entrypoint" || \
    fail "Deployment entry point is missing a required deployment safeguard: ${required_fragment}"
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
