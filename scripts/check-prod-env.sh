#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
MODE="${MODE:-production}"
STRICT_BACKUP="true"
ALLOW_PLACEHOLDERS="false"

usage() {
  cat <<'EOF'
Usage: scripts/check-prod-env.sh [--env-file PATH] [--mode staging|production] [--no-backup] [--allow-placeholders]

Validates production-like MoNexus environment files before compose deploys.

Default mode is strict: placeholders such as <secret> fail validation.
Use --allow-placeholders only to lint committed template files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --no-backup)
      STRICT_BACKUP="false"
      shift
      ;;
    --allow-placeholders)
      ALLOW_PLACEHOLDERS="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "staging" && "$MODE" != "production" ]]; then
  echo "[ERROR] --mode must be staging or production" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ERROR] Env file not found: $ENV_FILE" >&2
  exit 1
fi

declare -A env

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

strip_inline_comment() {
  local value="$1"
  local output=""
  local quote=""
  local char
  local i

  for ((i = 0; i < ${#value}; i++)); do
    char="${value:i:1}"
    if [[ -z "$quote" && "$char" == "#" ]]; then
      break
    fi
    if [[ "$char" == "\"" || "$char" == "'" ]]; then
      if [[ -z "$quote" ]]; then
        quote="$char"
      elif [[ "$quote" == "$char" ]]; then
        quote=""
      fi
    fi
    output+="$char"
  done

  printf '%s' "$output"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  line="$(trim "$line")"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == export\ * ]] && line="${line#export }"
  if [[ "$line" != *=* ]]; then
    continue
  fi
  key="$(trim "${line%%=*}")"
  value="$(trim "${line#*=}")"
  value="$(strip_inline_comment "$value")"
  value="$(trim "$value")"
  value="$(strip_quotes "$value")"
  env["$key"]="$value"
done < "$ENV_FILE"

errors=0
warnings=0

fail() {
  echo "[ERROR] $1" >&2
  errors=$((errors + 1))
}

warn() {
  echo "[WARN] $1" >&2
  warnings=$((warnings + 1))
}

get() {
  local key="$1"
  printf '%s' "${env[$key]:-}"
}

is_placeholder_literal() {
  local value="$1"
  [[ "$value" == *"<"* || "$value" == *">"* || "$value" == "changeme" || "$value" == "CHANGE_ME" ]]
}

require_value() {
  local key="$1"
  local value
  value="$(get "$key")"
  if [[ -z "$value" ]]; then
    fail "$key is required"
  elif is_placeholder_literal "$value"; then
    if [[ "$ALLOW_PLACEHOLDERS" == "true" ]]; then
      warn "$key is still a placeholder; replace it before a real deploy"
    else
      fail "$key is required and must not be a placeholder"
    fi
  fi
}

require_url() {
  local key="$1"
  local value
  value="$(get "$key")"
  require_value "$key"
  if [[ -n "$value" && "$value" != http://* && "$value" != https://* && "$value" != postgresql://* && "$value" != postgres://* ]]; then
    fail "$key must be a URL"
  fi
}

require_https_url() {
  local key="$1"
  local value
  value="$(get "$key")"
  require_value "$key"
  if [[ -n "$value" && "$value" != https://* ]]; then
    fail "$key must use https:// for $MODE"
  fi
}

require_bool_true() {
  local key="$1"
  local value
  value="$(get "$key")"
  if [[ "$value" != "true" ]]; then
    fail "$key must be true"
  fi
}

require_int() {
  local key="$1"
  local value
  value="$(get "$key")"
  require_value "$key"
  if [[ -n "$value" && ! "$value" =~ ^[0-9]+$ ]]; then
    fail "$key must be a non-negative integer"
  fi
}

require_value POSTGRES_USER
require_value POSTGRES_PASSWORD
require_value POSTGRES_DB

jwt_secret="$(get JWT_SECRET)"
require_value JWT_SECRET
if [[ ${#jwt_secret} -lt 32 ]]; then
  if [[ "$ALLOW_PLACEHOLDERS" == "true" ]] && is_placeholder_literal "$jwt_secret"; then
    :
  else
    fail "JWT_SECRET must be at least 32 characters"
  fi
fi

require_https_url FRONTEND_ORIGIN
require_bool_true COOKIE_SECURE

app_base_url="$(get APP_BASE_URL)"
if [[ -n "$app_base_url" ]]; then
  if [[ "$app_base_url" != https://* ]]; then
    fail "APP_BASE_URL must use https:// when set for $MODE"
  fi
else
  warn "APP_BASE_URL is empty; email links will fall back to FRONTEND_ORIGIN"
fi

require_int USER_STATUS_CACHE_TTL_SEC

require_url STORAGE_ENDPOINT
require_value STORAGE_BUCKET
require_value STORAGE_ACCESS_KEY
require_value STORAGE_SECRET_KEY
storage_public_url="$(get STORAGE_PUBLIC_URL_BASE)"
if [[ -z "$storage_public_url" ]]; then
  if [[ "$MODE" == "production" ]]; then
    fail "STORAGE_PUBLIC_URL_BASE is required in production so uploaded files have a public HTTPS URL"
  else
    warn "STORAGE_PUBLIC_URL_BASE is empty; uploaded image URLs may use storage endpoint defaults"
  fi
elif [[ "$storage_public_url" != https://* ]]; then
  fail "STORAGE_PUBLIC_URL_BASE must use https:// when set for $MODE"
fi

require_value SMTP_HOST
require_int SMTP_PORT
require_value SMTP_FROM
smtp_from="$(get SMTP_FROM)"
if [[ -n "$smtp_from" && ! "$smtp_from" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  fail "SMTP_FROM must be a valid email address"
fi
smtp_secure="$(get SMTP_SECURE)"
if [[ "$smtp_secure" != "true" && "$smtp_secure" != "false" ]]; then
  fail "SMTP_SECURE must be true or false"
fi
if [[ -z "$(get SMTP_USER)" || -z "$(get SMTP_PASS)" ]]; then
  if [[ "$MODE" == "production" ]]; then
    fail "SMTP_USER and SMTP_PASS are required in production"
  else
    warn "SMTP_USER or SMTP_PASS is empty; only acceptable for unauthenticated staging SMTP relays"
  fi
fi

require_https_url SENTRY_DSN
vite_sentry_dsn="$(get VITE_SENTRY_DSN)"
if [[ -n "$vite_sentry_dsn" && "$vite_sentry_dsn" != https://* ]]; then
  fail "VITE_SENTRY_DSN must use https:// when set"
elif [[ -z "$vite_sentry_dsn" ]]; then
  warn "VITE_SENTRY_DSN is empty; frontend error reporting is disabled"
fi

log_level="$(get LOG_LEVEL)"
if [[ -n "$log_level" && ! "$log_level" =~ ^(fatal|error|warn|info|debug|trace|silent)$ ]]; then
  fail "LOG_LEVEL must be one of fatal,error,warn,info,debug,trace,silent"
fi

metrics_token="$(get METRICS_TOKEN)"
require_value METRICS_TOKEN
if [[ ${#metrics_token} -lt 32 ]]; then
  if [[ "$ALLOW_PLACEHOLDERS" == "true" ]] && is_placeholder_literal "$metrics_token"; then
    :
  else
    fail "METRICS_TOKEN should be at least 32 characters"
  fi
fi

web_port="$(get WEB_PORT)"
if [[ -n "$web_port" && ! "$web_port" =~ ^[0-9]+$ ]]; then
  fail "WEB_PORT must be an integer when set"
fi

if [[ "$STRICT_BACKUP" == "true" ]]; then
  require_url BACKUP_DATABASE_URL
  require_url RESTORE_TARGET_URL
fi

if [[ "$errors" -gt 0 ]]; then
  echo "[FAIL] $ENV_FILE failed $MODE env validation with $errors error(s), $warnings warning(s)." >&2
  exit 1
fi

echo "[PASS] $ENV_FILE passed $MODE env validation with $warnings warning(s)."
