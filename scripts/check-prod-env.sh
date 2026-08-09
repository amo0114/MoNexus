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

require_redis_url() {
  local key="$1"
  local value
  value="$(get "$key")"
  require_value "$key"
  if [[ -n "$value" && "$value" != redis://* && "$value" != rediss://* ]]; then
    fail "$key must be a redis:// or rediss:// URL"
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

require_canonical_base64_32() {
  local key="$1"
  local value
  value="$(get "$key")"
  require_value "$key"

  if [[ -z "$value" ]]; then
    return
  fi
  if [[ "$ALLOW_PLACEHOLDERS" == "true" ]] && is_placeholder_literal "$value"; then
    return
  fi

  # Pipe the value rather than placing it on a child-process command line.
  # The check enforces standard, canonical base64 and exactly 32 decoded bytes.
  if ! printf '%s' "$value" | node -e '
    const { readFileSync } = require("node:fs")
    const raw = readFileSync(0, "utf8")
    const validAlphabet = /^[A-Za-z0-9+/]+={0,2}$/.test(raw)
    const decoded = validAlphabet ? Buffer.from(raw, "base64") : Buffer.alloc(0)
    if (!validAlphabet || decoded.length !== 32 || decoded.toString("base64") !== raw) process.exit(1)
  '; then
    fail "$key must be canonical standard base64 for exactly 32 bytes"
  fi
}

require_turnstile_allowed_hostnames() {
  local key="TURNSTILE_ALLOWED_HOSTNAMES"
  local value
  value="$(get "$key")"
  require_value "$key"

  if [[ -z "$value" ]]; then
    return
  fi
  if [[ "$ALLOW_PLACEHOLDERS" == "true" ]] && is_placeholder_literal "$value"; then
    return
  fi

  # Keep this parser aligned with config/index.ts: exact hostname values only,
  # without schemes, paths, ports, wildcards, or credential-like URL syntax.
  if ! printf '%s' "$value" | node -e '
    const { readFileSync } = require("node:fs")
    const raw = readFileSync(0, "utf8")
    const entries = raw.split(",").map(value => value.trim())
    if (entries.length === 0 || entries.some(value => value.length === 0)) process.exit(1)
    for (const entry of entries) {
      const candidate = entry.toLowerCase()
      if (!candidate || /[/:?#@]/.test(candidate)) process.exit(1)
      try {
        const parsed = new URL(`https://${candidate}`)
        if (
          parsed.hostname !== candidate
          || parsed.port
          || parsed.username
          || parsed.password
          || parsed.pathname !== "/"
          || parsed.search
          || parsed.hash
        ) process.exit(1)
      } catch {
        process.exit(1)
      }
    }
  '; then
    fail "$key must be a comma-separated list of exact hostnames without schemes, paths, ports, or wildcards"
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

require_canonical_base64_32 MFA_ENCRYPTION_KEY

# SPEC-RAP-001: public registration and user-email sending use Redis and
# Turnstile as fail-closed security dependencies. The server applies the same
# production rules at boot; surface a bad deploy before compose starts.
abuse_mode="$(get ABUSE_PROTECTION_MODE)"
if [[ "$abuse_mode" != "enforce" ]]; then
  fail "ABUSE_PROTECTION_MODE must be enforce for $MODE"
fi
require_canonical_base64_32 ABUSE_HASH_KEY
require_value TURNSTILE_SITE_KEY
require_value TURNSTILE_SECRET_KEY
require_turnstile_allowed_hostnames
require_bool_true REDIS_ENABLED
require_bool_true REDIS_REQUIRED
require_redis_url REDIS_URL

# SPEC-LEGAL-001: legal pages are deliberately switchable for staged rollout,
# but a production deploy must declare the state explicitly. Otherwise Compose
# would silently use its compatibility defaults and hide the legal pages.
legal_pages_enabled="$(get LEGAL_PAGES_ENABLED)"
legal_pages_enforcement="$(get LEGAL_PAGES_ENFORCEMENT)"
if [[ "$MODE" == "production" ]]; then
  require_value LEGAL_PAGES_ENABLED
  require_value LEGAL_PAGES_ENFORCEMENT
fi
if [[ -n "$legal_pages_enabled" && "$legal_pages_enabled" != "true" && "$legal_pages_enabled" != "false" ]]; then
  fail "LEGAL_PAGES_ENABLED must be true or false"
fi
if [[ -n "$legal_pages_enforcement" && "$legal_pages_enforcement" != "off" && "$legal_pages_enforcement" != "enforce" ]]; then
  fail "LEGAL_PAGES_ENFORCEMENT must be off or enforce"
fi
if [[ "$legal_pages_enabled" == "true" && "$legal_pages_enforcement" != "enforce" ]]; then
  fail "LEGAL_PAGES_ENABLED=true requires LEGAL_PAGES_ENFORCEMENT=enforce"
fi
if [[ "$legal_pages_enforcement" == "enforce" && "$legal_pages_enabled" != "true" ]]; then
  fail "LEGAL_PAGES_ENFORCEMENT=enforce requires LEGAL_PAGES_ENABLED=true"
fi
if [[ "$MODE" == "production" && -n "$(get LEGAL_PAGES_FIXTURE_PATH)" ]]; then
  fail "LEGAL_PAGES_FIXTURE_PATH must be empty in production"
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

# P5 controlled file delivery: the private bucket is mandatory in production —
# the fallback is process-memory storage and paid files vanish on restart.
require_value DELIVERY_STORAGE_BUCKET
require_url DELIVERY_STORAGE_PUBLIC_ENDPOINT
if [[ "$(get DELIVERY_STORAGE_BUCKET)" == "$(get STORAGE_BUCKET)" ]]; then
  fail "DELIVERY_STORAGE_BUCKET must differ from STORAGE_BUCKET: the public bucket carries an anonymous-download policy that would expose paid files"
fi
delivery_public_endpoint="$(get DELIVERY_STORAGE_PUBLIC_ENDPOINT)"
if [[ "$MODE" == "production" && -n "$delivery_public_endpoint" && "$delivery_public_endpoint" != https://* ]]; then
  fail "DELIVERY_STORAGE_PUBLIC_ENDPOINT must use https:// in production (SigV4 signs the exact origin browsers use)"
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

# P7b auto-provision: merchant webhook secrets are encrypted at rest (AES-256-GCM).
# Without the key the server cannot decrypt stored secrets to sign outbound calls;
# the config layer already refuses to boot in production without it — mirror that here
# so the failure surfaces before compose start.
webhook_enc_key="$(get WEBHOOK_SECRET_ENC_KEY)"
if [[ "$ALLOW_PLACEHOLDERS" == "true" ]] && is_placeholder_literal "$webhook_enc_key"; then
  warn "WEBHOOK_SECRET_ENC_KEY is still a placeholder; replace it before a real deploy"
elif [[ -n "$webhook_enc_key" ]]; then
  if [[ ! "$webhook_enc_key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    fail "WEBHOOK_SECRET_ENC_KEY must be 64 hex characters (32 bytes) — generate with: openssl rand -hex 32"
  fi
elif [[ "$MODE" == "production" ]]; then
  fail "WEBHOOK_SECRET_ENC_KEY is required in production (merchant webhook secrets are encrypted at rest)"
fi

# AUTO_PROVISION_ALLOW_INSECURE_TARGETS is a dev-only escape hatch that disables the
# SSRF protections (https-only, IP pinning) on merchant webhook calls. It must never
# be truthy in production — the config layer refuses to boot; fail loudly here too.
allow_insecure="$(get AUTO_PROVISION_ALLOW_INSECURE_TARGETS)"
if [[ "$MODE" == "production" && "$allow_insecure" == "true" ]]; then
  fail "AUTO_PROVISION_ALLOW_INSECURE_TARGETS must not be true in production: it disables SSRF protections on merchant webhook calls"
fi

sentry_dsn="$(get SENTRY_DSN)"
if [[ -n "$sentry_dsn" && "$sentry_dsn" != https://* ]]; then
  fail "SENTRY_DSN must use https:// when set"
elif [[ -z "$sentry_dsn" ]]; then
  warn "SENTRY_DSN is empty; backend error reporting is disabled"
fi
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
  backup_source="$(get BACKUP_SOURCE)"
  # Older env files omitted BACKUP_SOURCE and used a reachable database URL.
  # Keep that behavior, while allowing the VPS stack to back up its private
  # Postgres through Docker Compose instead.
  if [[ -z "$backup_source" ]]; then
    backup_source="url"
  fi
  case "$backup_source" in
    url)
      require_url BACKUP_DATABASE_URL
      ;;
    docker-compose)
      ;;
    *)
      fail "BACKUP_SOURCE must be url or docker-compose"
      ;;
  esac
  require_value BACKUP_AGE_RECIPIENT
  backup_age_recipient="$(get BACKUP_AGE_RECIPIENT)"
  if [[ -n "$backup_age_recipient" && ! "$backup_age_recipient" =~ ^age1 ]]; then
    if [[ "$ALLOW_PLACEHOLDERS" == "true" ]] && is_placeholder_literal "$backup_age_recipient"; then
      :
    else
      fail "BACKUP_AGE_RECIPIENT must be an age public recipient beginning with age1"
    fi
  fi
  require_url RESTORE_TARGET_URL
fi

# --- SPEC-NOTIFY-RT-001: realtime config validation + trust-proxy topology. ---
realtime_enabled="$(get NOTIFICATION_REALTIME_ENABLED)"
notification_enabled="$(get NOTIFICATION_ENABLED)"
if [[ -n "$realtime_enabled" && "$realtime_enabled" != "true" && "$realtime_enabled" != "false" ]]; then
  fail "NOTIFICATION_REALTIME_ENABLED must be true or false"
fi
if [[ "$realtime_enabled" == "true" && "$notification_enabled" != "true" ]]; then
  fail "NOTIFICATION_REALTIME_ENABLED=true requires NOTIFICATION_ENABLED=true"
fi

check_realtime_int() {
  local key="$1" min="$2" max="$3" value
  value="$(get "$key")"
  if [[ -n "$value" && ! "$value" =~ ^[0-9]+$ ]]; then
    fail "$key must be a decimal integer"
  elif [[ -n "$value" && ( "$value" -lt "$min" || "$value" -gt "$max" ) ]]; then
    fail "$key must be in [$min,$max]"
  fi
}
check_realtime_int NOTIFICATION_REALTIME_HEARTBEAT_MS 5000 60000
check_realtime_int NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_USER 1 20
check_realtime_int NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_IP 1 200
check_realtime_int NOTIFICATION_REALTIME_MAX_CONNECTIONS 1 100000
check_realtime_int NOTIFICATION_REALTIME_MAX_BUFFER_BYTES 16384 1048576
check_realtime_int NOTIFICATION_REALTIME_CONNECT_RATE_LIMIT_MAX 1 1000
check_realtime_int NOTIFICATION_REALTIME_SHUTDOWN_GRACE_MS 1000 9000

# canonical client IP (spec 8.1.1 / CHK-CFG-004): direct bundled Nginx = 1,
# VPS Caddy overlay -> Nginx = 2. The SSE limiter keys on Express req.ip.
deploy_topology="$(get DEPLOY_TOPOLOGY)"
case "$deploy_topology" in
  ""|nginx) deploy_topology="nginx" ;;
  caddy) ;;
  *) fail "DEPLOY_TOPOLOGY must be nginx or caddy" ;;
esac
trust_proxy="$(get TRUST_PROXY)"
if [[ -n "$trust_proxy" ]]; then
  case "$trust_proxy" in
    0|1|2|true|false) ;;
    *) fail "TRUST_PROXY must be 0/1/2 or true/false" ;;
  esac
fi
if [[ "$realtime_enabled" == "true" ]]; then
  if [[ "$deploy_topology" == "caddy" && "$trust_proxy" != "2" ]]; then
    fail "realtime with Caddy overlay requires TRUST_PROXY=2"
  elif [[ "$deploy_topology" == "nginx" && "$trust_proxy" != "1" ]]; then
    fail "realtime with direct Nginx requires TRUST_PROXY=1"
  fi
fi

if [[ "$errors" -gt 0 ]]; then
  echo "[FAIL] $ENV_FILE failed $MODE env validation with $errors error(s), $warnings warning(s)." >&2
  exit 1
fi

echo "[PASS] $ENV_FILE passed $MODE env validation with $warnings warning(s)."
