#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR"
BACKEND_DIR="$ROOT_DIR/server"
SEED=false
LOCAL_DATABASE_URL="${DATABASE_URL:-postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public}"
LOCAL_JWT_SECRET="${JWT_SECRET:-local-development-secret-must-be-at-least-32-chars}"
LOCAL_FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:5173}"
LOCAL_REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

if [[ "${1:-}" == "--seed" || "${1:-}" == "seed" ]]; then
  SEED=true
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found in PATH."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker not found in PATH."
  exit 1
fi

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -qE "^${key}=" "$file"; then
    local tmp
    tmp="$(mktemp)"
    awk -v key="$key" -v value="$value" 'BEGIN { replaced = 0 }
      $0 ~ "^" key "=" {
        print key "=" value
        replaced = 1
        next
      }
      { print }
      END {
        if (replaced == 0) print key "=" value
      }' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

wait_for_container() {
  local name="$1"
  local label="$2"

  for _ in {1..30}; do
    local status
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      echo "[INFO] $label is $status."
      return 0
    fi
    sleep 1
  done

  echo "[ERROR] $label did not become ready."
  docker ps -a --filter "name=$name"
  exit 1
}

ensure_container() {
  local service="$1"
  local name="$2"
  local label="$3"

  if docker ps --filter "name=^/${name}$" --filter "status=running" --format '{{.Names}}' | grep -qx "$name"; then
    echo "[INFO] $label container is already running."
  elif docker ps -a --filter "name=^/${name}$" --format '{{.Names}}' | grep -qx "$name"; then
    echo "[INFO] Restarting existing $label container..."
    docker start "$name" >/dev/null
  else
    echo "[INFO] Creating $label container..."
    (cd "$ROOT_DIR" && docker compose up -d "$service")
  fi

  wait_for_container "$name" "$label"
}

echo '[INFO] Starting local dependencies: PostgreSQL + Redis...'
ensure_container postgres monexus-db PostgreSQL
ensure_container redis monexus-redis Redis

if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  if [[ -f "$BACKEND_DIR/.env.example" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    echo '[INFO] Created server/.env from .env.example'
  else
    echo "[ERROR] Missing $BACKEND_DIR/.env and .env.example"
    exit 1
  fi
fi

echo '[INFO] Configuring server/.env for local dev cache testing...'
upsert_env "$BACKEND_DIR/.env" NODE_ENV development
upsert_env "$BACKEND_DIR/.env" PORT 3000
upsert_env "$BACKEND_DIR/.env" DATABASE_URL "$LOCAL_DATABASE_URL"
upsert_env "$BACKEND_DIR/.env" JWT_SECRET "$LOCAL_JWT_SECRET"
upsert_env "$BACKEND_DIR/.env" FRONTEND_ORIGIN "$LOCAL_FRONTEND_ORIGIN"
upsert_env "$BACKEND_DIR/.env" COOKIE_SECURE false
upsert_env "$BACKEND_DIR/.env" REDIS_ENABLED true
upsert_env "$BACKEND_DIR/.env" REDIS_URL "$LOCAL_REDIS_URL"
upsert_env "$BACKEND_DIR/.env" REDIS_PASSWORD ""
upsert_env "$BACKEND_DIR/.env" REDIS_TLS false
upsert_env "$BACKEND_DIR/.env" REDIS_REQUIRED false
upsert_env "$BACKEND_DIR/.env" REDIS_CONNECT_TIMEOUT_MS 100
upsert_env "$BACKEND_DIR/.env" REDIS_COMMAND_TIMEOUT_MS 80
upsert_env "$BACKEND_DIR/.env" REDIS_CIRCUIT_ERROR_THRESHOLD 5
upsert_env "$BACKEND_DIR/.env" REDIS_CIRCUIT_OPEN_MS 30000
upsert_env "$BACKEND_DIR/.env" CACHE_KEY_PREFIX monexus:local
upsert_env "$BACKEND_DIR/.env" CACHE_PRODUCT_LIST true
upsert_env "$BACKEND_DIR/.env" CACHE_PRODUCT_DETAIL true
upsert_env "$BACKEND_DIR/.env" CACHE_PRODUCT_REVIEWS true
upsert_env "$BACKEND_DIR/.env" CACHE_PRODUCT_LIST_VERSION_COALESCE_MS 10000
upsert_env "$BACKEND_DIR/.env" CACHE_MAX_VALUE_BYTES 524288

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo '[INFO] Installing frontend dependencies...'
  (cd "$FRONTEND_DIR" && npm install)
fi

if [[ ! -d "$BACKEND_DIR/node_modules" ]]; then
  echo '[INFO] Installing backend dependencies...'
  (cd "$BACKEND_DIR" && npm install)
fi

echo '[INFO] Preparing backend runtime...'
(cd "$BACKEND_DIR" && npm run db:generate)
(cd "$BACKEND_DIR" && npx prisma migrate deploy)

if [[ "$SEED" == "true" ]]; then
  (cd "$BACKEND_DIR" && npm run db:seed)
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

echo '[INFO] Starting backend...'
(
  cd "$BACKEND_DIR"
  REDIS_ENABLED=true \
    REDIS_URL="$LOCAL_REDIS_URL" \
    REDIS_REQUIRED=false \
    CACHE_KEY_PREFIX=monexus:local \
    CACHE_PRODUCT_LIST=true \
    CACHE_PRODUCT_DETAIL=true \
    CACHE_PRODUCT_REVIEWS=true \
    npm run dev
) &
BACKEND_PID=$!

echo '[INFO] Starting frontend...'
echo 'Backend:  http://localhost:3000'
echo 'Frontend: http://localhost:5173'
echo 'Redis:    redis://localhost:6379'
echo 'Admin:    admin@moyuan.net / admin123'
echo 'User:     test@moyuan.net / user123'
echo 'Merchant: merchant@moyuan.net / merchant123'
echo
echo 'Tip: use "bash scripts/dev-up.sh --seed" when you want to re-run seed.'
echo 'Tip: check Redis readiness with "curl http://localhost:3000/api/health/ready".'

cd "$FRONTEND_DIR"
npm run dev
