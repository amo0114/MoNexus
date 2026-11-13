#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Run the real API fixtures in a disposable database, using the deployed image.
# No staging business rows, live administrator credentials, or provider calls.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$root" == /opt/monexus-staging/releases/* ]] || { echo 'Dedicated staging release required.' >&2; exit 2; }
[[ "${1:-}" == REHEARSE_STAGING_RUNTIME ]] || { echo 'Missing rehearsal confirmation.' >&2; exit 2; }
compose=(docker compose --project-name monexus-staging --env-file /etc/monexus/staging.env
  -f "$root/docker-compose.prod.yml" -f "$root/docker-compose.vps.yml" -f "$root/docker-compose.staging.yml")
database="monexus_runtime_$(date -u +%Y%m%d%H%M%S)_${RANDOM}"
runner="monexus-runtime-rehearsal-${database}"
runner_env="$(mktemp /etc/monexus/.runtime-rehearsal.XXXXXX)"
created=false
cleanup() {
  local result=$?
  trap - EXIT
  docker rm -f "$runner" >/dev/null 2>&1 || true
  if [[ "$created" == true ]]; then
    if ! "${compose[@]}" exec -T postgres sh -c 'exec dropdb --force -U "$POSTGRES_USER" "$1"' -- "$database"; then
      echo '[ERROR] Disposable rehearsal database cleanup failed.' >&2
      result=1
    fi
  fi
  rm -f -- "$runner_env"
  exit "$result"
}
trap cleanup EXIT

server_id="$("${compose[@]}" ps -q server)"
[[ -n "$server_id" ]] || { echo 'No staging server is running.' >&2; exit 1; }
image="$(docker inspect --format '{{.Image}}' "$server_id")"
network="$(docker inspect --format '{{range $name, $settings := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$server_id" | head -n1)"
[[ "$network" == monexus-staging_* ]] || { echo 'Unexpected staging network.' >&2; exit 1; }
"${compose[@]}" exec -T server node --input-type=module - "$database" > "$runner_env" <<'NODE'
const url = new URL(process.env.DATABASE_URL)
if (url.hostname !== 'postgres' || !/^monexus_runtime_[0-9]+_[0-9]+$/.test(process.argv[2])) throw new Error('Unsafe rehearsal database')
url.pathname = '/' + process.argv[2]
const env = { DATABASE_URL: url.href, TEST_DATABASE_URL: url.href, NODE_ENV: 'test',
  MONEXUS_DEPLOY_ENV: 'staging', JWT_SECRET: 'isolated-runtime-rehearsal-secret-at-least-32',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), REDIS_ENABLED: 'false', REDIS_REQUIRED: 'false',
  ABUSE_PROTECTION_MODE: 'off', RECHARGE_MODE: 'sandbox', PAYMENT_ENABLED_PROVIDERS: '', PAYMENT_REGISTERED_PROVIDERS: '' }
process.stdout.write(Object.entries(env).map(([key, value]) => key + '=' + value).join('\n') + '\n')
NODE
"${compose[@]}" exec -T postgres sh -c 'exec createdb -U "$POSTGRES_USER" "$1"' -- "$database"
created=true
docker run --rm --name "$runner" --network "$network" --env-file "$runner_env" \
  -v "$root/server/src:/app/src:ro" -v "$root/server/vitest.config.ts:/app/vitest.config.ts:ro" \
  -v "$root/server/tsconfig.json:/app/tsconfig.json:ro" \
  --entrypoint sh "$image" -c '
    node scripts/migrate-deploy.mjs &&
    node node_modules/vitest/vitest.mjs run \
      src/__tests__/admin-mail-settings.test.ts \
      src/__tests__/admin-shortlink-settings.test.ts \
      src/__tests__/admin-faka-runtime.test.ts \
      src/__tests__/payment-runtime-settings.test.ts \
      src/__tests__/runtime-settings-multi-process.test.ts \
      src/__tests__/runtime-notification-settings.test.ts'

# Read-only check against the actual deployed application environment.
"${compose[@]}" exec -T server node --input-type=module <<'NODE'
import { config } from './dist/config/index.js'
import { prisma } from './dist/lib/prisma.js'
import { encryptMailCredentials, decryptMailCredentials, getMailRuntimeConfig } from './dist/lib/mailer/runtimeConfig.js'
import { encryptIntegrationCredentials, decryptIntegrationCredentials } from './dist/lib/runtimeSettings/credentials.js'
const settings = { host: 'runtime-rehearsal.invalid', port: 587, secure: false, from: 'fixture@example.test', fromName: 'Fixture' }
const credentials = { user: 'in-memory-fixture', pass: 'in-memory-fixture' }
const mail = decryptMailCredentials(encryptMailCredentials(credentials, settings), settings)
const integration = decryptIntegrationCredentials('fixture', 'fixture', {}, encryptIntegrationCredentials('fixture', 'fixture', {}, credentials))
const migrations = await prisma.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name LIKE '20261113%runtime%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
if (mail.pass !== credentials.pass || integration.pass !== credentials.pass || config.mailCredentialsEncKey === config.integrationCredentialsEncKey || migrations[0].count !== 4) throw new Error('Runtime readiness check failed')
console.log(JSON.stringify({ mailEncryptionReady: true, integrationEncryptionReady: true, rootsIndependent: true, runtimeMigrationsApplied: migrations[0].count, mailSource: (await getMailRuntimeConfig()).source, businessConfigurationChanged: false }))
await prisma.$disconnect()
NODE
echo '[PASS] Staging runtime rehearsal completed in a disposable database.'
