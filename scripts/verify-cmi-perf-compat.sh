#!/usr/bin/env bash
set -u

# Local-only evidence runner for CMI G-CAT/MERCH-PR-009.  It never contacts
# staging/production and does not create or migrate a database.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "CMI local performance/cache/compat verification"
node --version
npm --version

echo "[cache] deterministic wrapper, single-flight, negative-cache and version tests"
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "cache_tests=PENDING (TEST_DATABASE_URL is required by the repository Vitest safety guard)"
elif (cd server && npm test -- --run src/__tests__/cache.test.ts); then
  echo "cache_tests=PASS"
else
  echo "cache_tests=FAIL"
  exit 1
fi

echo "[compat] TypeScript production build (no schema or migration changes)"
node_major="${NODE_VERSION:-$(node -p 'process.versions.node.split(".")[0]')}"
npm_major="$(npm --version | cut -d. -f1)"
if [[ "$node_major" != "20" || "$npm_major" != "10" ]]; then
  echo "server_build=PENDING (repository requires Node 20.x/npm 10.x; found Node ${node_major}.x/npm ${npm_major}.x)"
elif (cd server && npm run build); then
  echo "server_build=PASS"
else
  echo "server_build=FAIL"
  exit 1
fi

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  echo "[performance] dashboard benchmark (local TEST_DATABASE_URL only)"
  if (cd server && npm test -- --run src/__tests__/dashboard.bench.test.ts); then
    echo "dashboard_benchmark=PASS"
  else
    echo "dashboard_benchmark=FAIL"
    exit 1
  fi
else
  echo "dashboard_benchmark=PENDING (set TEST_DATABASE_URL to an existing local test DB; runner does not provision/reset it)"
fi

echo "external_staging_production_p95=PENDING"
echo "external_100k_orders_p95=PENDING"
echo "frontend_bundle_budget=PENDING"
