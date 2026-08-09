#!/usr/bin/env bash
# SPEC-NOTIFY-RT-001 — isolated staging host rehearsal primitives.
#
# This script is called only by the protected Staging Compose Deploy workflow.
# It never edits /etc/monexus/staging.env: a private per-run copy is used for
# feature flags and the temporary canary rate limit, then securely removed.

set -Eeuo pipefail

CONFIRMATION='monexus-staging-notification-realtime'
BASE_PATH='/opt/monexus-staging'
SOURCE_ENV_FILE='/etc/monexus/staging.env'
PROJECT_NAME='monexus-staging'
SAMPLE_COUNT='100'

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: notification-realtime-staging-host.sh ACTION RELEASE_SHA RUN_ID [ARCHIVE]

Actions:
  prepare         extract release; flag-off backend-first deployment
  session         run the production-like LISTEN session gate
  enable          enable realtime and recreate only the backend
  fixture-create  create a run-scoped fixture (password read from stdin)
  frontend-build  build, but do not publish, the feature frontend
  frontend        publish frontend after flag-on smoke (token read from stdin)
  logs            inspect app/proxy logs (token + sentinel read from stdin)
  flag-off        disable realtime and prove the REST/polling fallback boundary
  rollback        roll code back to the captured baseline release
  fixture-clean   remove only the exact synthetic fixture
  finalize        restore original env runtime and remove the private env copy
  recover         flag-off, rollback, fixture cleanup and env restore with evidence
EOF
}

action="${1:-}"
release_sha="${2:-}"
run_id="${3:-}"
source_archive="${4:-}"

if [[ "${RT_STAGING_CONFIRM:-}" != "$CONFIRMATION" ]]; then
  fail 'staging rehearsal confirmation is missing'
fi
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'release SHA must be 40 lowercase hex characters'
[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'invalid staging rehearsal run ID'
[[ "${COMPOSE_PROJECT_NAME:-$PROJECT_NAME}" == "$PROJECT_NAME" ]] || fail 'refusing a non-staging Compose project'
[[ "${RT_STAGING_SAMPLE_COUNT:-$SAMPLE_COUNT}" == "$SAMPLE_COUNT" ]] || fail 'release rehearsal requires exactly 100 samples'

release_path="$BASE_PATH/releases/$release_sha"
run_path="$BASE_PATH/rehearsals/$run_id"
run_env="$run_path/staging.env"
baseline_file="$run_path/baseline.sha"
evidence_path="$run_path/evidence"
fixture_file="$run_path/fixture.json"
status_file="$run_path/status"

set_status() {
  local value="$1"
  [[ "$value" =~ ^[A-Z_]+$ ]] || fail 'invalid rehearsal status'
  printf '%s\n' "$value" > "$status_file"
  chmod 600 "$status_file"
}

current_status() {
  if [[ -f "$status_file" ]]; then
    tr -cd 'A-Z_\n' < "$status_file" | head -n 1
  else
    printf 'UNKNOWN'
  fi
}

set_env_value() {
  local file="$1" key="$2" value="$3" temp
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || fail 'invalid environment key'
  [[ "$value" != *$'\n'* ]] || fail 'environment value contains a newline'
  temp="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$file" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$file"
}

baseline_sha() {
  [[ -f "$baseline_file" ]] || fail 'staging rehearsal baseline is missing'
  local value
  value="$(<"$baseline_file")"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || fail 'staging baseline is invalid'
  printf '%s' "$value"
}

require_run() {
  [[ -d "$release_path" ]] || fail 'feature release is missing'
  [[ -f "$run_env" ]] || fail 'private rehearsal environment is missing'
  [[ -d "$evidence_path" ]] || fail 'rehearsal evidence directory is missing'
}

compose_for() {
  local root="$1" env_file="$2"
  COMPOSE_PROJECT_NAME="$PROJECT_NAME" ENV_FILE="$env_file" \
    bash "$root/scripts/staging-compose.sh" "$3"
}

wait_public_local() {
  # prod-smoke uses the loopback WEB_PORT from the private env and exercises
  # the currently served web -> backend path without exposing any credential.
  local root="$1" env_file="$2"
  compose_for "$root" "$env_file" smoke
}

run_fixture() {
  local mode="$1" password="${2:-}"
  local compose=(
    docker compose
    --project-name "$PROJECT_NAME"
    --env-file "$run_env"
    -f "$release_path/docker-compose.prod.yml"
    -f "$release_path/docker-compose.vps.yml"
    --profile selfhost-storage
    --profile staging-mail
  )
  local env_args=(
    -e "RT_STAGING_FIXTURE_CONFIRM=$CONFIRMATION"
    -e "RT_STAGING_FIXTURE_MODE=$mode"
    -e "RT_STAGING_RUN_ID=$run_id"
    -e "RT_STAGING_HEAD=$release_sha"
    -e "RT_STAGING_SAMPLE_COUNT=$SAMPLE_COUNT"
  )
  if [[ "$mode" == create ]]; then
    # Password is the first stdin line. BusyBox sh consumes it and leaves the
    # streamed module for Node; the secret never appears in docker/host argv.
    {
      printf '%s\n' "$password"
      cat "$release_path/server/scripts/notification-realtime-staging-fixture.mjs"
    } | "${compose[@]}" exec -T "${env_args[@]}" server sh -c \
      'IFS= read -r RT_STAGING_FIXTURE_PASSWORD; export RT_STAGING_FIXTURE_PASSWORD; exec node --input-type=module'
    return
  fi
  "${compose[@]}" exec -T "${env_args[@]}" server node --input-type=module \
    < "$release_path/server/scripts/notification-realtime-staging-fixture.mjs"
}

prepare() {
  [[ -f "$SOURCE_ENV_FILE" ]] || fail 'private staging environment is missing'
  [[ -f "$source_archive" ]] || fail 'staging source archive is missing'
  local active_caddy='/etc/caddy/sites-enabled/monexus-staging.caddy'
  [[ -r "$active_caddy" ]] || fail 'active staging Caddy site is not readable'
  grep -Fq 'reverse_proxy 127.0.0.1:18081' "$active_caddy" || fail 'active staging Caddy upstream is unexpected'
  grep -Fq 'flush_interval -1' "$active_caddy" || fail 'active staging Caddy site has not enabled immediate SSE flushing'
  mkdir -p "$BASE_PATH/releases" "$BASE_PATH/rehearsals"
  if [[ -e "$release_path" ]]; then
    [[ "$(cat "$release_path/.staging-release-id" 2>/dev/null || true)" == "$release_sha" ]] || \
      fail 'existing feature release has the wrong identity'
  else
    local incoming
    incoming="$(mktemp -d "$BASE_PATH/releases/.incoming-${release_sha}.XXXXXX")"
    trap 'rm -rf "$incoming"' RETURN
    tar -xzf "$source_archive" -C "$incoming"
    [[ -x "$incoming/scripts/staging-compose.sh" ]] || fail 'release has no staging launcher'
    [[ -x "$incoming/scripts/notification-realtime-staging-host.sh" ]] || fail 'release has no rehearsal host script'
    printf '%s\n' "$release_sha" > "$incoming/.staging-release-id"
    mv "$incoming" "$release_path"
    trap - RETURN
  fi
  if [[ -e "$run_path" ]]; then
    fail "staging rehearsal run already exists (status=$(current_status)); use a new workflow attempt"
  fi
  install -d -m 700 "$run_path" "$evidence_path"
  install -m 600 "$SOURCE_ENV_FILE" "$run_env"
  set_status PREPARING

  local current baseline
  current="$(readlink -f "$BASE_PATH/current" 2>/dev/null || true)"
  [[ "$current" == "$BASE_PATH/releases/"* ]] || fail 'current staging release is not an immutable release'
  baseline="${current##*/}"
  [[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || fail 'current staging release SHA is invalid'
  [[ "$baseline" != "$release_sha" ]] || fail 'rehearsal requires a distinct rollback baseline'
  [[ "$(cat "$current/.staging-release-id" 2>/dev/null || true)" == "$baseline" ]] || fail 'baseline identity mismatch'
  [[ -x "$current/scripts/staging-compose.sh" ]] || fail 'baseline has no staging launcher'
  printf '%s\n' "$baseline" > "$baseline_file"

  set_env_value "$run_env" NOTIFICATION_ENABLED true
  set_env_value "$run_env" NOTIFICATION_REALTIME_ENABLED false
  set_env_value "$run_env" API_RATE_LIMIT_MAX 5000
  set_env_value "$run_env" DEPLOY_TOPOLOGY caddy
  set_env_value "$run_env" TRUST_PROXY 2

  # Deploy only the reviewed Nginx proxy template while the baseline frontend
  # assets remain in place. This satisfies the proxy-first/old-frontend
  # compatibility boundary without publishing the new bridge prematurely.
  local baseline_compose=(
    docker compose
    --project-name "$PROJECT_NAME"
    --env-file "$run_env"
    -f "$current/docker-compose.prod.yml"
    -f "$current/docker-compose.vps.yml"
    --profile selfhost-storage
    --profile staging-mail
  )
  local web_container
  web_container="$("${baseline_compose[@]}" ps -q web)"
  [[ -n "$web_container" ]] || fail 'baseline web container is not running'
  docker cp "$release_path/nginx.conf" "$web_container:/etc/nginx/templates/default.conf.template"
  docker exec "$web_container" /docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null
  docker exec "$web_container" nginx -t
  docker exec "$web_container" nginx -s reload

  compose_for "$release_path" "$run_env" build-backend
  compose_for "$release_path" "$run_env" up-backend
  wait_public_local "$release_path" "$run_env"
  {
    echo 'backend_first=PASS'
    echo 'proxy_first=PASS'
    echo "head=$release_sha"
    echo "collected_at=$(date -u +%FT%TZ)"
  } > "$evidence_path/rollout.partial"
  chmod 600 "$evidence_path/rollout.partial"
  set_status PREPARED
  # Retain the immutable archive until every preparation step succeeds so a
  # failed run remains recoverable/retryable from the exact uploaded source.
  rm -f "$source_archive"
}

run_session_gate() {
  require_run
  # POSTGRES_USER is the deployment declaration. The Compose server URL is
  # hard-wired to the private `postgres` service, so endpoint class is direct.
  set +x
  set -a
  # shellcheck disable=SC1090
  source "$run_env"
  set +a
  : "${POSTGRES_USER:?POSTGRES_USER is required}"
  local compose=(
    docker compose
    --project-name "$PROJECT_NAME"
    --env-file "$run_env"
    -f "$release_path/docker-compose.prod.yml"
    -f "$release_path/docker-compose.vps.yml"
    --profile selfhost-storage
    --profile staging-mail
  )
  local output="$evidence_path/session.txt"
  "${compose[@]}" exec -T \
    -e "RT_SESSION_ROLE=$POSTGRES_USER" \
    -e RT_SESSION_ENDPOINT_CLASS=direct \
    -e "RT_SESSION_REVISION=$release_sha" \
    server sh -c 'RT_SESSION_DATABASE_URL="$DATABASE_URL" node --input-type=module' \
    < "$release_path/server/scripts/verify-notification-realtime-listen-session.mjs" \
    | tee "$output"
  {
    echo 'result=PASS'
    echo "head=$release_sha"
    echo "collected_at=$(date -u +%FT%TZ)"
    echo 'reviewer=github-actions-environment:staging'
  } >> "$output"
  chmod 600 "$output"
}

enable_realtime() {
  require_run
  set_status ENABLING
  set_env_value "$run_env" NOTIFICATION_REALTIME_ENABLED true
  compose_for "$release_path" "$run_env" up-backend
  {
    cat "$evidence_path/rollout.partial"
    echo 'flag_on=PASS'
  } > "$evidence_path/rollout.partial.next"
  mv "$evidence_path/rollout.partial.next" "$evidence_path/rollout.partial"
  chmod 600 "$evidence_path/rollout.partial"
  set_status REALTIME_ENABLED
}

fixture_create() {
  require_run
  local password temp_fixture
  IFS= read -r password
  [[ ${#password} -ge 20 ]] || fail 'fixture password is missing'
  set_status FIXTURE_CREATING
  temp_fixture="$(mktemp "$run_path/.fixture.XXXXXX")"
  trap 'rm -f "$temp_fixture"' RETURN
  run_fixture create "$password" > "$temp_fixture"
  [[ -s "$temp_fixture" ]] || fail 'fixture metadata was not created'
  chmod 600 "$temp_fixture"
  mv "$temp_fixture" "$fixture_file"
  trap - RETURN
  set_status FIXTURE_CREATED
  echo '[PASS] credential-free fixture metadata created on the staging host'
}

build_frontend() {
  require_run
  compose_for "$release_path" "$run_env" build-frontend
  set_status FRONTEND_BUILT
}

deploy_frontend() {
  require_run
  local token
  IFS= read -r token
  [[ -n "$token" ]] || fail 'frontend smoke token is missing'
  compose_for "$release_path" "$run_env" up-frontend
  NOTIFICATION_REALTIME_SMOKE_TOKEN="$token" wait_public_local "$release_path" "$run_env"
  ln -sfn "$release_path" "$BASE_PATH/current"
  {
    cat "$evidence_path/rollout.partial"
    echo 'frontend_after=PASS'
    echo 'result=PASS'
  } > "$evidence_path/rollout.txt"
  chmod 600 "$evidence_path/rollout.txt"
  set_status FEATURE_ACTIVE
}

inspect_logs() {
  require_run
  local token sentinel since topology temp_dir
  IFS= read -r token
  IFS= read -r sentinel
  [[ -n "$token" && "$sentinel" =~ ^rt-proxy-sentinel-[A-Za-z0-9._-]+$ ]] || fail 'invalid log sentinel input'
  since="${RT_STAGING_LOG_SINCE:-10 minutes ago}"
  temp_dir="$(mktemp -d "$run_path/.logs.XXXXXX")"
  trap 'rm -rf "$temp_dir"' RETURN
  local compose=(
    docker compose
    --project-name "$PROJECT_NAME"
    --env-file "$run_env"
    -f "$release_path/docker-compose.prod.yml"
    -f "$release_path/docker-compose.vps.yml"
    --profile selfhost-storage
    --profile staging-mail
  )
  "${compose[@]}" logs --since "$since" web > "$temp_dir/nginx.log" 2>&1
  "${compose[@]}" logs --since "$since" server > "$temp_dir/app.log" 2>&1
  if grep -Fq -- "$token" "$temp_dir/nginx.log" "$temp_dir/app.log" || \
     grep -Fq -- "$sentinel" "$temp_dir/nginx.log" "$temp_dir/app.log"; then
    fail 'credential or sentinel appeared in Nginx/app logs'
  fi

  topology="$(awk -F= '$1 == "DEPLOY_TOPOLOGY" { value=$2 } END { print value }' "$run_env")"
  topology="${topology:-nginx}"
  local caddy_result='NOT_APPLICABLE' caddy_log_mode='not_applicable'
  if [[ "$topology" == caddy ]]; then
    local active_caddy='/etc/caddy/sites-enabled/monexus-staging.caddy'
    [[ -r "$active_caddy" ]] || fail 'active staging Caddy site is not readable'
    grep -Fq 'flush_interval -1' "$active_caddy" || fail 'active Caddy SSE flush contract is missing'
    # The dedicated site intentionally has no access-log directive; Caddy
    # therefore has no request log in which Authorization could be recorded.
    # Nginx and app runtime logs are still queried above.
    if grep -Eq '^[[:space:]]*log([[:space:]]|$)' "$active_caddy"; then
      fail 'Caddy access logging is enabled but no approved redacted query is configured'
    fi
    caddy_result='PASS'
    caddy_log_mode='site_access_log_disabled'
  elif [[ "$topology" != nginx ]]; then
    fail 'unsupported deployed proxy topology'
  fi

  {
    echo 'result=PASS'
    echo "head=$release_sha"
    echo "collected_at=$(date -u +%FT%TZ)"
    echo "topology=$topology"
    echo 'nginx=PASS'
    echo 'app=PASS'
    echo "caddy=$caddy_result"
    echo "caddy_log_mode=$caddy_log_mode"
  } > "$evidence_path/logs.txt"
  chmod 600 "$evidence_path/logs.txt"
  rm -rf "$temp_dir"
  trap - RETURN
}

disable_realtime() {
  require_run
  set_env_value "$run_env" NOTIFICATION_REALTIME_ENABLED false
  compose_for "$release_path" "$run_env" up-backend
  wait_public_local "$release_path" "$run_env"
  {
    echo 'flag_off=PASS'
    echo "head=$release_sha"
    echo "collected_at=$(date -u +%FT%TZ)"
  } > "$evidence_path/rollback.partial"
  chmod 600 "$evidence_path/rollback.partial"
  set_status FLAG_OFF
}

rollback_code() {
  require_run
  local baseline baseline_path
  baseline="$(baseline_sha)"
  baseline_path="$BASE_PATH/releases/$baseline"
  compose_for "$baseline_path" "$run_env" up
  wait_public_local "$baseline_path" "$run_env"
  ln -sfn "$baseline_path" "$BASE_PATH/current"
  echo 'code_rollback=PASS' >> "$evidence_path/rollback.partial"
  set_status CODE_ROLLED_BACK
}

fixture_clean() {
  require_run
  run_fixture cleanup > "$evidence_path/fixture-cleanup.json"
  chmod 600 "$evidence_path/fixture-cleanup.json"
  rm -f "$fixture_file"
  set_status FIXTURE_CLEAN
}

finalize_run() {
  require_run
  local baseline baseline_path
  baseline="$(baseline_sha)"
  baseline_path="$BASE_PATH/releases/$baseline"
  compose_for "$baseline_path" "$SOURCE_ENV_FILE" restart
  wait_public_local "$baseline_path" "$SOURCE_ENV_FILE"
  rm -f "$run_env"
  {
    cat "$evidence_path/rollback.partial"
    echo 'rest_polling_history=PASS'
    echo 'result=PASS'
  } > "$evidence_path/rollback.txt"
  chmod 600 "$evidence_path/rollback.txt"
  set_status COMPLETE
}

recover_run() {
  set +e
  local recovery_report="$evidence_path/recovery.txt"
  local recovery_failed=0 baseline='' baseline_path='' fixture_ok=false restore_ok=false
  local previous_status
  previous_status="$(current_status)"

  recovery_line() {
    printf '%s\n' "$*"
    if [[ -d "$evidence_path" ]]; then printf '%s\n' "$*" >> "$recovery_report"; fi
  }

  recovery_step() {
    local name="$1"
    shift
    echo "[RECOVERY] starting ${name}" >&2
    if ( "$@" ); then
      recovery_line "${name}=PASS"
      return 0
    else
      local step_code=$?
      recovery_line "${name}=FAIL"
      echo "[RECOVERY] ${name} failed with exit ${step_code}" >&2
      return 1
    fi
  }

  recover_flag_off() {
    [[ -f "$run_env" && -d "$release_path" ]] || return 1
    set_env_value "$run_env" NOTIFICATION_REALTIME_ENABLED false
    compose_for "$release_path" "$run_env" up-backend
  }

  recover_fixture() {
    [[ -f "$run_env" && -d "$release_path" ]] || return 1
    run_fixture cleanup > "$evidence_path/fixture-cleanup-recovery.json"
    chmod 600 "$evidence_path/fixture-cleanup-recovery.json"
    rm -f "$fixture_file"
  }

  recover_code() {
    [[ -n "$baseline_path" && -d "$baseline_path" && -f "$run_env" ]] || return 1
    compose_for "$baseline_path" "$run_env" up
    wait_public_local "$baseline_path" "$run_env"
    ln -sfn "$baseline_path" "$BASE_PATH/current"
  }

  recover_runtime() {
    [[ -n "$baseline_path" && -d "$baseline_path" && -f "$SOURCE_ENV_FILE" ]] || return 1
    compose_for "$baseline_path" "$SOURCE_ENV_FILE" restart
    wait_public_local "$baseline_path" "$SOURCE_ENV_FILE"
    ln -sfn "$baseline_path" "$BASE_PATH/current"
  }

  if [[ ! -f "$run_env" ]]; then
    recovery_line "previous_status=$previous_status"
    recovery_line 'result=NO_CHANGES'
    set -e
    return 0
  fi

  install -d -m 700 "$evidence_path"
  : > "$recovery_report"
  chmod 600 "$recovery_report"
  recovery_line "previous_status=$previous_status"
  recovery_line "head=$release_sha"
  recovery_line "collected_at=$(date -u +%FT%TZ)"

  if [[ -f "$baseline_file" ]]; then baseline="$(<"$baseline_file")"; fi
  if [[ "$baseline" =~ ^[0-9a-f]{40}$ && -d "$BASE_PATH/releases/$baseline" ]]; then
    baseline_path="$BASE_PATH/releases/$baseline"
    recovery_line 'baseline_resolved=PASS'
  else
    recovery_line 'baseline_resolved=FAIL'
    recovery_failed=1
  fi

  case "$previous_status" in
    PREPARING|PREPARED)
      recovery_line 'flag_off=NOT_NEEDED'
      ;;
    *)
      recovery_step flag_off recover_flag_off || recovery_failed=1
      ;;
  esac
  case "$previous_status" in
    PREPARING|PREPARED|REALTIME_ENABLED)
      recovery_line 'fixture_cleanup=NOT_NEEDED'
      fixture_ok=true
      ;;
    *)
      if recovery_step fixture_cleanup recover_fixture; then
        fixture_ok=true
      else
        recovery_failed=1
      fi
      ;;
  esac
  recovery_step code_rollback recover_code || recovery_failed=1
  if recovery_step env_runtime_restore recover_runtime; then
    restore_ok=true
  else
    recovery_failed=1
  fi

  if [[ "$recovery_failed" -eq 0 && "$fixture_ok" == true && "$restore_ok" == true ]]; then
    rm -f "$run_env"
    set_status RECOVERED
    recovery_line 'result=PASS'
    set -e
    return 0
  fi

  set_status RECOVERY_FAILED || true
  recovery_line 'result=FAIL'
  recovery_line 'manual_intervention_required=true'
  set -e
  return 1
}

case "$action" in
  prepare) prepare ;;
  session) run_session_gate ;;
  enable) enable_realtime ;;
  fixture-create) fixture_create ;;
  frontend-build) build_frontend ;;
  frontend) deploy_frontend ;;
  logs) inspect_logs ;;
  flag-off) disable_realtime ;;
  rollback) rollback_code ;;
  fixture-clean) fixture_clean ;;
  finalize) finalize_run ;;
  recover) recover_run ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
