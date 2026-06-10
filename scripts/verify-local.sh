#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/server"

TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public}"
RUN_E2E="${RUN_E2E:-true}"
INSTALL_PLAYWRIGHT="${INSTALL_PLAYWRIGHT:-true}"
JWT_SECRET="${JWT_SECRET:-local-jwt-secret-at-least-32-characters-long}"
FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:5173}"

if [[ "$TEST_DATABASE_URL" != *"monexus_test"* && "${ALLOW_NON_TEST_DB:-false}" != "true" ]]; then
  echo "[ERROR] TEST_DATABASE_URL must point at a disposable test database." >&2
  echo "        Current value: $TEST_DATABASE_URL" >&2
  echo "        Set ALLOW_NON_TEST_DB=true only if you know this database can be reset." >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd npm

echo "[INFO] Checking local runtime"
(cd "$ROOT_DIR" && npm run check:runtime)

echo "[INFO] Starting PostgreSQL container"
(cd "$ROOT_DIR" && docker compose up -d postgres)

echo "[INFO] Waiting for PostgreSQL health"
for _ in {1..30}; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' monexus-db 2>/dev/null || true)"
  if [[ "$status" == "healthy" || "$status" == "running" ]]; then
    break
  fi
  sleep 1
done

if ! docker ps --filter "name=monexus-db" --filter "status=running" --format '{{.Names}}' | grep -qx 'monexus-db'; then
  echo "[ERROR] PostgreSQL container is not running." >&2
  exit 1
fi

echo "[INFO] Ensuring monexus_test database exists"
(cd "$ROOT_DIR" && docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" monexus_test 2>/dev/null || true')

echo "[INFO] Generating Prisma client"
(cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npm run db:generate)

echo "[INFO] Applying migrations to test database"
(cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate:deploy)

echo "[INFO] Building backend"
(cd "$BACKEND_DIR" && npm run build)

echo "[INFO] Building frontend"
(cd "$ROOT_DIR" && npm run build)

echo "[INFO] Running backend tests"
(cd "$BACKEND_DIR" && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test)

if [[ "$RUN_E2E" != "true" ]]; then
  echo "[INFO] Skipping E2E because RUN_E2E=$RUN_E2E"
  exit 0
fi

echo "[INFO] Resetting test database before E2E seed"
(cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate reset --force --skip-seed)

echo "[INFO] Seeding E2E fixtures"
(cd "$BACKEND_DIR" && DATABASE_URL="$TEST_DATABASE_URL" npm run db:seed:force)

if [[ "$INSTALL_PLAYWRIGHT" == "true" ]]; then
  echo "[INFO] Ensuring Playwright Chromium is installed"
  (cd "$ROOT_DIR" && npx playwright install chromium)
fi

echo "[INFO] Running Playwright E2E"
(
  cd "$ROOT_DIR"
  DATABASE_URL="$TEST_DATABASE_URL" \
    JWT_SECRET="$JWT_SECRET" \
    FRONTEND_ORIGIN="$FRONTEND_ORIGIN" \
    COOKIE_SECURE=false \
    npm run e2e
)

echo "[INFO] Local verification gate passed"
