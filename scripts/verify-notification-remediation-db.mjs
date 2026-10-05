import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (Number(process.versions.node.split('.')[0]) !== 20) {
  throw new Error('Notification remediation verification requires Node.js 20')
}
if (process.argv.length > 2) throw new Error('This verifier accepts no database URL or other arguments')

const serverDirectory = fileURLToPath(new URL('../server/', import.meta.url))
const require = createRequire(`${serverDirectory}/package.json`)
const { Client } = require('pg')
const identifier = randomUUID().replaceAll('-', '').slice(0, 12)
const containerName = `monexus-notify-verification-${identifier}`
const databaseName = `monexus_test_notify_r1r2_${identifier}`
const password = randomUUID().replaceAll('-', '')
const containerEnvironment = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
}
let containerCreated = false
let connectionString = ''
let testEnvironment

function redact(output) {
  return output.replaceAll(password, '[temporary credential redacted]')
    .replaceAll(connectionString || 'UNSET_CONNECTION_STRING', '[temporary database URL redacted]')
}

function execute(command, argumentsList, label, { quiet = false, environment = testEnvironment } = {}) {
  console.log(`Starting ${label}`)
  const result = spawnSync(command, argumentsList, {
    cwd: serverDirectory,
    env: environment ?? containerEnvironment,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 900_000,
  })
  if (!quiet || result.status !== 0) {
    console.log(redact(`${result.stdout ?? ''}${result.stderr ?? ''}`))
  }
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? 'unavailable'})`)
  }
  console.log(`Passed ${label}`)
  return result.stdout?.trim() ?? ''
}

const suites = [
  'src/__tests__/auth.test.ts',
  'src/__tests__/auth-sessions.test.ts',
  'src/__tests__/auth-mfa.test.ts',
  'src/__tests__/announcements.test.ts',
  'src/__tests__/auth-active-user.test.ts',
  'src/__tests__/auth-jwt-errors.test.ts',
  'src/__tests__/auth-tokens.test.ts',
  'src/__tests__/auth-identity-foundation.test.ts',
  'src/__tests__/auth-security-events.test.ts',
  'src/__tests__/registration-auth-flow.test.ts',
  'src/__tests__/auth-mfa-crypto.test.ts',
  'src/__tests__/notification-remediation-concurrency.test.ts',
]

try {
  const dockerHost = execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 'local Docker context check', { quiet: true })
  if (!dockerHost.startsWith('unix://')) throw new Error('Refusing a non-local Docker context')
  execute('docker', [
    'run', '--detach', '--rm', '--pull=never', '--name', containerName,
    '--label', 'monexus.task=notification-r1-r2-verification',
    '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data:rw,size=536870912',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', 'POSTGRES_USER=monexus_test',
    '--env', `POSTGRES_DB=${databaseName}`,
    'postgres:16',
  ], 'disposable PostgreSQL 16 container', { quiet: true })
  containerCreated = true
  const address = execute('docker', ['port', containerName, '5432/tcp'], 'loopback port discovery', { quiet: true })
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Unexpected non-loopback container binding')
  connectionString = `postgresql://monexus_test:${password}@${address}/${databaseName}`
  // Do not read .env files or inherit real integration credentials.
  testEnvironment = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TZ: 'UTC',
    DOTENV_CONFIG_PATH: '/dev/null',
    DATABASE_URL: connectionString,
    TEST_DATABASE_URL: connectionString,
    NODE_ENV: 'test',
    REDIS_ENABLED: 'false',
    REDIS_REQUIRED: 'false',
    CACHE_KEY_PREFIX: databaseName,
    SMTP_HOST: '',
    RECHARGE_MODE: 'disabled',
    LOG_LEVEL: 'warn',
  }
  let databaseReady = false
  for (let attempt = 0; attempt < 40; attempt++) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1000 })
    try {
      await client.connect()
      const result = await client.query("SELECT current_database() AS database, current_setting('server_version') AS version")
      if (result.rows[0].database !== databaseName || !result.rows[0].version.startsWith('16.')) {
        throw new Error('Database identity/version mismatch')
      }
      console.log(`Verified isolated database ${databaseName}; PostgreSQL ${result.rows[0].version}`)
      databaseReady = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    } finally {
      await client.end()
    }
  }
  if (!databaseReady) throw new Error('PostgreSQL 16 readiness/version check failed')
  execute(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], 'schema migration on PostgreSQL 16', { quiet: true })
  execute(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...suites], 'R1/R2 PostgreSQL 16 integration and concurrency gates')
} catch (error) {
  console.error(redact(error.message))
  process.exitCode = 1
} finally {
  if (containerCreated) {
    try {
      execute('docker', ['rm', '--force', '--volumes', containerName], 'disposable PostgreSQL 16 cleanup', { quiet: true, environment: containerEnvironment })
      const remaining = execute('docker', ['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}'], 'container absence verification', { quiet: true, environment: containerEnvironment })
      if (remaining) throw new Error('Disposable container remains after cleanup')
      console.log('Cleanup verified: container removed; tmpfs database discarded; no host data mount created')
    } catch (error) {
      console.error(redact(error.message))
      process.exitCode = 1
    }
  }
}
