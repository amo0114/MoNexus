#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
provided_m3_url="${M3_ISH_DATABASE_URL:-}"
provided_test_url="${TEST_DATABASE_URL:-}"

if [[ -n "$provided_m3_url" && -n "$provided_test_url" && "$provided_m3_url" != "$provided_test_url" ]]; then
  echo '[ERROR] M3_ISH_DATABASE_URL and TEST_DATABASE_URL must match when both are supplied.' >&2
  exit 1
fi

isolated_database_url="${provided_m3_url:-$provided_test_url}"
if [[ -z "$isolated_database_url" ]]; then
  echo '[ERROR] Set M3_ISH_DATABASE_URL or TEST_DATABASE_URL to the isolated M3-ISH test database.' >&2
  exit 1
fi

if ! node - "$isolated_database_url" <<'NODE'
const value = process.argv[2]
try {
  const url = new URL(value)
  const databaseName = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || databaseName !== 'monexus_m3_ish_test') {
    process.exit(1)
  }
} catch {
  process.exit(1)
}
NODE
then
  echo '[ERROR] The M3-ISH verifier only permits the monexus_m3_ish_test PostgreSQL database.' >&2
  exit 1
fi

export M3_ISH_DATABASE_URL="$isolated_database_url"
export TEST_DATABASE_URL="$isolated_database_url"
export DATABASE_URL="$isolated_database_url"

cd "$project_root/server"
npx prisma migrate status
npx prisma migrate diff --from-url "$M3_ISH_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code

cd "$project_root"
npm --prefix server test
npm --prefix server run build
npm run build
npm run prod:env:staging-template
npx playwright test --config playwright.m3-identity-security-hardening.config.ts
