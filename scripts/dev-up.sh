#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR"
BACKEND_DIR="$ROOT_DIR/server"
SEED=false

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

if ! docker ps --filter "name=monexus-db" --filter "status=running" --format '{{.Names}}' | grep -qx 'monexus-db'; then
  echo '[ERROR] PostgreSQL container "monexus-db" is not running.'
  echo 'Please start it manually first:'
  echo '  docker compose up -d postgres'
  exit 1
fi

if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  if [[ -f "$BACKEND_DIR/.env.example" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    echo '[INFO] Created server/.env from .env.example'
  else
    echo "[ERROR] Missing $BACKEND_DIR/.env and .env.example"
    exit 1
  fi
fi

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
(cd "$BACKEND_DIR" && npm run dev) &
BACKEND_PID=$!

echo '[INFO] Starting frontend...'
echo 'Backend:  http://localhost:3000'
echo 'Frontend: http://localhost:5173'
echo 'Admin:    admin@moyuan.net / admin123'
echo 'User:     test@moyuan.net / user123'
echo 'Merchant: merchant@moyuan.net / merchant123'
echo
echo 'Tip: use "bash scripts/dev-up.sh --seed" when you want to re-run seed.'

cd "$FRONTEND_DIR"
npm run dev
