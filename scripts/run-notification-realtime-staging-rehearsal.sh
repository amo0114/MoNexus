#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 — GitHub runner orchestration for the protected staging
# rollout/rollback rehearsal. Secrets remain in GitHub Environment memory or
# the staging host; uploaded artifacts contain aggregate evidence only.

set -Eeuo pipefail
set +x

CONFIRMATION='monexus-staging-notification-realtime'
SAMPLE_COUNT='100'

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

for key in \
  STAGING_SSH_HOST STAGING_SSH_USER STAGING_SSH_PORT STAGING_HEALTHCHECK_URL \
  DEPLOY_COMMIT GITHUB_RUN_ID GITHUB_RUN_ATTEMPT; do
  [[ -n "${!key:-}" ]] || fail "missing required environment value: $key"
done
[[ "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'DEPLOY_COMMIT must be a full SHA'
[[ "$STAGING_HEALTHCHECK_URL" == https://*/api/health/ready ]] || fail 'unexpected staging healthcheck URL'
[[ "${RT_STAGING_CONFIRM:-}" == "$CONFIRMATION" ]] || fail 'live rehearsal confirmation is missing'

run_id="${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}"
base_url="${STAGING_HEALTHCHECK_URL%/api/health/ready}"
remote_archive="/tmp/monexus-staging-${DEPLOY_COMMIT}.tar.gz"
remote_release="/opt/monexus-staging/releases/${DEPLOY_COMMIT}"
remote_script="$remote_release/scripts/notification-realtime-staging-host.sh"
remote_run="/opt/monexus-staging/rehearsals/${run_id}"
ssh_target="${STAGING_SSH_USER}@${STAGING_SSH_HOST}"
ssh_key="${STAGING_SSH_KEY_FILE:-$HOME/.ssh/monexus_staging_deploy}"

ssh_args=(
  -i "$ssh_key"
  -p "$STAGING_SSH_PORT"
  -o StrictHostKeyChecking=yes
)
scp_args=(
  -i "$ssh_key"
  -P "$STAGING_SSH_PORT"
  -o StrictHostKeyChecking=yes
)

artifact_dir="${RT_STAGING_ARTIFACT_DIR:-artifacts/notification-realtime-staging-${DEPLOY_COMMIT}}"
mkdir -p "$artifact_dir"
chmod 700 "$artifact_dir"
private_dir="$(mktemp -d)"
fixture_file="$private_dir/fixture.json"
state_file="$private_dir/state.json"
token_file="$private_dir/merchant-token"
latency_file="$artifact_dir/staging-latency.txt"
completed=false

remote_env="RT_STAGING_CONFIRM=$CONFIRMATION COMPOSE_PROJECT_NAME=monexus-staging RT_STAGING_SAMPLE_COUNT=$SAMPLE_COUNT"

remote_action() {
  local requested_action="$1"
  ssh "${ssh_args[@]}" "$ssh_target" \
    "$remote_env bash '$remote_script' '$requested_action' '$DEPLOY_COMMIT' '$run_id'"
}

remote_input_action() {
  local requested_action="$1" input="$2"
  printf '%s\n' "$input" | ssh "${ssh_args[@]}" "$ssh_target" \
    "$remote_env bash '$remote_script' '$requested_action' '$DEPLOY_COMMIT' '$run_id'"
}

recover() {
  local exit_code=$?
  local final_code="$exit_code" recovery_code=0
  if [[ "$completed" != true ]]; then
    echo '[WARN] Rehearsal failed; attempting flag-off, baseline rollback, fixture cleanup and env restoration.' >&2
    set +e
    ssh "${ssh_args[@]}" "$ssh_target" \
      "$remote_env bash -s -- recover '$DEPLOY_COMMIT' '$run_id'" \
      < scripts/notification-realtime-staging-host.sh \
      2>&1 | tee "$artifact_dir/recovery-runner.txt"
    recovery_code="${PIPESTATUS[0]}"
    if [[ "$recovery_code" -ne 0 ]]; then
      echo "[ERROR] Automatic staging recovery failed with exit ${recovery_code}; manual intervention is required." >&2
      [[ "$final_code" -ne 0 ]] || final_code="$recovery_code"
    else
      echo '[PASS] Automatic staging recovery completed and was recorded.' >&2
    fi
  fi
  rm -rf "$private_dir"
  trap - EXIT
  exit "$final_code"
}
trap recover EXIT

public_readiness() {
  local expected="$1" body="$private_dir/readiness.json"
  curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-connrefused \
    "$STAGING_HEALTHCHECK_URL" > "$body"
  EXPECTED_REALTIME="$expected" READINESS_FILE="$body" node <<'NODE'
const fs = require('node:fs')
const body = JSON.parse(fs.readFileSync(process.env.READINESS_FILE, 'utf8'))
if (body.status !== 'ready') throw new Error('staging readiness is not ready')
if (body.checks?.notificationRealtime !== process.env.EXPECTED_REALTIME) {
  throw new Error('staging realtime readiness state mismatch')
}
NODE
  echo "[PASS] public staging readiness notificationRealtime=${expected}"
}

echo '[stage 1/12] Prepare proxy-first + backend-first release with realtime disabled'
ssh "${ssh_args[@]}" "$ssh_target" \
  "$remote_env bash -s -- prepare '$DEPLOY_COMMIT' '$run_id' '$remote_archive'" \
  < scripts/notification-realtime-staging-host.sh
public_readiness disabled

echo '[stage 2/12] Run production-like LISTEN session gate'
remote_action session

echo '[stage 3/12] Enable realtime on the feature backend only'
remote_action enable
public_readiness ok

echo '[stage 4/12] Create disposable staging canary fixture metadata'
fixture_password="$(node -e "console.log(require('node:crypto').randomBytes(30).toString('base64url'))")"
echo "::add-mask::$fixture_password"
remote_input_action fixture-create "$fixture_password"
scp "${scp_args[@]}" "$ssh_target:$remote_run/fixture.json" "$fixture_file"
chmod 600 "$fixture_file"

echo '[stage 5/12] Build the feature frontend without publishing it'
remote_action frontend-build

printf '%s\n' "$fixture_password" | \
RT_STAGING_CONFIRM="$CONFIRMATION" \
RT_STAGING_COLLECTOR_MODE=token \
RT_STAGING_HEAD="$DEPLOY_COMMIT" \
RT_STAGING_BASE_URL="$base_url" \
RT_STAGING_FIXTURE_FILE="$fixture_file" \
RT_STAGING_TOKEN_FILE="$token_file" \
  node scripts/notification-realtime-staging-collector.mjs
merchant_token="$(tr -d '\r\n' < "$token_file")"
[[ -n "$merchant_token" ]] || fail 'fresh merchant token was not created'
echo "::add-mask::$merchant_token"

echo '[stage 6/12] Prove external proxy transport before publishing the new frontend'
sentinel="rt-proxy-sentinel-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
NOTIFICATION_REALTIME_PROXY_BASE="$base_url" \
NOTIFICATION_REALTIME_PROXY_TOKEN="$merchant_token" \
NOTIFICATION_REALTIME_PROXY_SENTINEL="$sentinel" \
  bash scripts/verify-notification-realtime-proxy.sh | tee "$artifact_dir/proxy.txt"
{
  echo 'result=PASS'
  echo "head=$DEPLOY_COMMIT"
  echo "collected_at=$(date -u +%FT%TZ)"
} >> "$artifact_dir/proxy.txt"

echo '[stage 7/12] Publish frontend after backend/listener/proxy readiness'
remote_input_action frontend "$merchant_token"
public_readiness ok

echo '[stage 8/12] Collect 100 API-2xx to merchant-DOM latency samples'
printf '%s\n' "$fixture_password" | \
RT_STAGING_CONFIRM="$CONFIRMATION" \
RT_STAGING_COLLECTOR_MODE=latency \
RT_STAGING_HEAD="$DEPLOY_COMMIT" \
RT_STAGING_BASE_URL="$base_url" \
RT_STAGING_FIXTURE_FILE="$fixture_file" \
RT_STAGING_STATE_FILE="$state_file" \
RT_STAGING_SAMPLE_COUNT="$SAMPLE_COUNT" \
RT_STAGING_LATENCY_EVIDENCE_FILE="$latency_file" \
  node scripts/notification-realtime-staging-collector.mjs

echo '[stage 9/12] Inspect deployed Nginx/app/Caddy log boundaries'
printf '%s\n%s\n' "$merchant_token" "$sentinel" | ssh "${ssh_args[@]}" "$ssh_target" \
  "$remote_env bash '$remote_script' logs '$DEPLOY_COMMIT' '$run_id'"

echo '[stage 10/12] Disable realtime and prove application-owned 30s fallback/history'
remote_action flag-off
public_readiness disabled
printf '%s\n' "$fixture_password" | \
RT_STAGING_CONFIRM="$CONFIRMATION" \
RT_STAGING_COLLECTOR_MODE=fallback \
RT_STAGING_HEAD="$DEPLOY_COMMIT" \
RT_STAGING_BASE_URL="$base_url" \
RT_STAGING_FIXTURE_FILE="$fixture_file" \
RT_STAGING_STATE_FILE="$state_file" \
  node scripts/notification-realtime-staging-collector.mjs

echo '[stage 11/12] Roll code back to the captured immutable baseline and verify history'
remote_action rollback
printf '%s\n' "$fixture_password" | \
RT_STAGING_CONFIRM="$CONFIRMATION" \
RT_STAGING_COLLECTOR_MODE=history \
RT_STAGING_HEAD="$DEPLOY_COMMIT" \
RT_STAGING_BASE_URL="$base_url" \
RT_STAGING_FIXTURE_FILE="$fixture_file" \
RT_STAGING_STATE_FILE="$state_file" \
  node scripts/notification-realtime-staging-collector.mjs

echo '[stage 12/12] Remove fixture, restore original staging env runtime and collect evidence'
remote_action fixture-clean
remote_action finalize

for name in session.txt logs.txt rollout.txt rollback.txt fixture-cleanup.json; do
  scp "${scp_args[@]}" "$ssh_target:$remote_run/evidence/$name" "$artifact_dir/$name"
done
baseline_sha="$(ssh "${ssh_args[@]}" "$ssh_target" "cat '$remote_run/baseline.sha'")"
[[ "$baseline_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'captured rollback baseline is invalid'
{
  echo 'result=PASS'
  echo "head=$DEPLOY_COMMIT"
  echo "baseline_head=$baseline_sha"
  echo 'environment=staging'
  echo "collected_at=$(date -u +%FT%TZ)"
  echo "workflow_run=${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-amo0114/MoNexus}/actions/runs/${GITHUB_RUN_ID}"
} > "$artifact_dir/rehearsal-meta.txt"
chmod 600 "$artifact_dir"/*

completed=true
echo "[PASS] staging rollout/rollback rehearsal completed for $DEPLOY_COMMIT and restored baseline $baseline_sha"
