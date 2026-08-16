#!/usr/bin/env bash
set -euo pipefail

# Disposable-CMI evidence runner for the legacy Product.isHot cleanup contract.
# It only touches TEST_DATABASE_URL and never performs a production migration.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must point to the disposable CMI database}"
export DATABASE_URL="$TEST_DATABASE_URL"
scripts/cmi/dbguard.sh current-db >/dev/null

echo "CMI legacy isHot cleanup verification"
echo "database=monexus_test_catalog_merch_integration"

# Seed once to materialize the exact demo rows managed by the idempotent cleanup.
# Seed output contains local credentials/invite material and is intentionally not
# copied into the evidence log.
NODE_ENV=test npm --prefix server run db:seed >/dev/null

before="$(cd server && ./node_modules/.bin/tsx src/scripts/cmiLegacyHotFixture.ts prepare)"
echo "$before"

# Re-running the same seed is the production-shaped idempotent cleanup path.
NODE_ENV=test npm --prefix server run db:seed >/dev/null

after="$(cd server && ./node_modules/.bin/tsx src/scripts/cmiLegacyHotFixture.ts verify)"
echo "$after"
echo "legacy_is_hot_cleanup=PASS"
