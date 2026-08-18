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

monitoring_workflow="${ROOT_DIR}/.github/workflows/production-monitoring-rehearsal.yml"
[[ -f "$monitoring_workflow" ]] || fail 'Production monitoring rehearsal workflow is missing.'
if command -v ruby >/dev/null 2>&1; then
  ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$monitoring_workflow" >/dev/null
fi
for required_fragment in \
  'environment: production' \
  'required_reviewers' \
  'REHEARSE_VALUE_POLICY_EMAIL_PRODUCTION' \
  'StrictHostKeyChecking=yes' \
  'DEPLOY_SSH_KNOWN_HOSTS' \
  'rehearse-alert ${ROUTING}'; do
  grep -Fq "$required_fragment" "$monitoring_workflow" || \
    fail "Monitoring rehearsal workflow is missing required safeguard: ${required_fragment}"
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
  "readonly STARTUP_MAX_ATTEMPTS='90'" \
  "readonly STARTUP_RETRY_DELAY_SECONDS='2'" \
  'NOTIFICATION_REALTIME_ENABLED false' \
  'frontend-build' \
  'read -r RT_STAGING_FIXTURE_PASSWORD' \
  'recover_run' \
  'manual_intervention_required=true' \
  'fixture-clean'; do
  grep -Fq "$required_fragment" "${ROOT_DIR}/scripts/notification-realtime-staging-host.sh" || \
    fail "Staging host script is missing required recovery boundary: ${required_fragment}"
done

restore_sequence_count="$(
  awk '
    function trim_indent(value) {
      sub(/^[[:space:]]+/, "", value)
      return value
    }
    trim_indent($0) == "compose_for \"$baseline_path\" \"$SOURCE_ENV_FILE\" up-backend" {
      if ((getline second) > 0 &&
          trim_indent(second) == "compose_for \"$baseline_path\" \"$SOURCE_ENV_FILE\" up-frontend" &&
          (getline third) > 0 &&
          trim_indent(third) == "wait_public_local \"$baseline_path\" \"$SOURCE_ENV_FILE\"") {
        count += 1
      }
    }
    END { print count + 0 }
  ' "${ROOT_DIR}/scripts/notification-realtime-staging-host.sh"
)"
[[ "$restore_sequence_count" == '2' ]] || \
  fail 'Staging runtime restore must recreate backend before frontend in finalize and recovery paths.'

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
for required_fragment in \
  'profiles: [production-monitoring]' \
  'image: prom/alertmanager:v0.30.0@sha256:abb750ac7b63116761c16dd481ae92496fbe04721686c0920f0fa4d0728cd4a6' \
  'image: prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996' \
  'container_name: monexus-prometheus-prod' \
  'container_name: monexus-alertmanager-prod' \
  '/opt/monexus-monitoring/config/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro' \
  'file: /opt/monexus-monitoring/secrets/metrics_token' \
  'file: /opt/monexus-monitoring/secrets/smtp_password' \
  'no-new-privileges:true'; do
  grep -Fq "$required_fragment" "${ROOT_DIR}/docker-compose.prod.yml" || \
    fail "Compose is missing required private monitoring safeguard: ${required_fragment}"
done
if awk '
  /^  (prometheus|alertmanager):$/ { in_monitoring = 1; next }
  in_monitoring && /^  [A-Za-z0-9_-]+:$/ { in_monitoring = 0 }
  in_monitoring && /^[[:space:]]+ports:/ { found = 1 }
  END { exit found ? 0 : 1 }
' "${ROOT_DIR}/docker-compose.prod.yml"; then
  fail 'Prometheus and Alertmanager must not publish host ports.'
fi

prometheus_config="${ROOT_DIR}/deploy/monitoring/prometheus.yml"
[[ -f "$prometheus_config" ]] || fail 'Prometheus production configuration is missing.'
for required_fragment in \
  'bearer_token_file: /run/secrets/metrics_token' \
  'server:3000' \
  'alertmanager:9093' \
  '/etc/prometheus/rules/value-policy-alerts.rules.yml'; do
  grep -Fq "$required_fragment" "$prometheus_config" || \
    fail "Prometheus configuration is missing required private scrape contract: ${required_fragment}"
done

entrypoint="${ROOT_DIR}/deploy/vps/monexus-compose-deploy"
for required_fragment in \
  "readonly VPS_PROXY_OVERLAY_KEY='MONEXUS_USE_VPS_PROXY_OVERLAY'" \
  'if use_vps_proxy_overlay; then' \
  "notice 'Using the base Compose port mapping; existing direct WEB_PORT exposure is preserved.'" \
  '[[ -f "${release_path}/scripts/check-prod-env.sh" ]] ||' \
  'bash "${release_path}/scripts/check-prod-env.sh" --mode production --env-file "$ENV_FILE"' \
  'compose+=(--profile selfhost-storage --profile production-monitoring)' \
  'prepare_monitoring_runtime' \
  'validate_monitoring_runtime "$release_path"' \
  "readonly ALERTMANAGER_IMAGE='prom/alertmanager:v0.30.0@sha256:abb750ac7b63116761c16dd481ae92496fbe04721686c0920f0fa4d0728cd4a6'" \
  "readonly PROMETHEUS_IMAGE='prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996'" \
  'smtp_auth_password_file: /run/secrets/alertmanager_smtp_password' \
  'assert_monitoring_contract' \
  'run_alert_rehearsal'; do
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
for forbidden_command in \
  'shell' \
  'deploy abcdef' \
  'deploy 0123456789012345678901234567890123456789 extra' \
  'rehearse-alert invalid' \
  'rehearse-alert value-policy-p0 extra'; do
  if SSH_ORIGINAL_COMMAND="$forbidden_command" "$wrapper" >/dev/null 2>&1; then
    fail "Forced-command wrapper accepted an invalid command: ${forbidden_command}"
  fi
done

echo '[PASS] Compose production deployment contract is syntactically valid and retains its core safeguards.'
