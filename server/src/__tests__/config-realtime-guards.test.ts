import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

/**
 * SPEC-NOTIFY-RT-001 config guard tests (spec 8.1 / AC-RT-014 / CHK-CFG-001~002).
 * The config module validates and process.exit(1)s at import time, so every case
 * runs in an isolated child process — never process.exit inside the Vitest main
 * process.
 */

const SERVER_ROOT = path.resolve(__dirname, '..', '..')

const DEV_BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_SECRET: 'a-sufficiently-long-test-secret-32chars!!',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
}

function loadConfigWith(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [key, value] of Object.entries({ ...DEV_BASE_ENV, ...overrides })) {
    if (value !== undefined) env[key] = value
  }
  return spawnSync(
    'npx',
    ['tsx', '-e', "import('./src/config/index.js').then(() => { console.log('CONFIG_OK'); process.exit(0) })"],
    { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 }
  )
}

/** Loads config and prints the notificationRealtime section as JSON. */
function dumpRealtimeConfig(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [key, value] of Object.entries({ ...DEV_BASE_ENV, ...overrides })) {
    if (value !== undefined) env[key] = value
  }
  const result = spawnSync(
    'npx',
    [
      'tsx',
      '-e',
      "import('./src/config/index.js').then((m) => { console.log('RT=' + JSON.stringify(m.config.notificationRealtime)); process.exit(0) })",
    ],
    { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 }
  )
  return result
}

describe('CHK-CFG-001 — realtime config defaults and range validation (spec 8.1)', () => {
  it('applies spec defaults when unset', () => {
    const result = dumpRealtimeConfig({})
    expect(result.status).toBe(0)
    const line = (result.stdout + result.stderr).split('\n').find(l => l.startsWith('RT='))
    expect(line).toBeDefined()
    const cfg = JSON.parse(line!.slice('RT='.length))
    expect(cfg).toEqual({
      enabled: false,
      heartbeatMs: 20000,
      maxConnectionsPerUser: 5,
      maxConnectionsPerIp: 20,
      maxConnections: 1000,
      maxBufferBytes: 65536,
      connectRateLimitMax: 30,
      shutdownGraceMs: 5000,
    })
  })

  it('applies spec defaults for empty strings (treated as unset)', () => {
    const result = dumpRealtimeConfig({
      NOTIFICATION_REALTIME_ENABLED: '',
      NOTIFICATION_REALTIME_HEARTBEAT_MS: '',
      NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_USER: '',
      NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_IP: '',
      NOTIFICATION_REALTIME_MAX_CONNECTIONS: '',
      NOTIFICATION_REALTIME_MAX_BUFFER_BYTES: '',
      NOTIFICATION_REALTIME_CONNECT_RATE_LIMIT_MAX: '',
      NOTIFICATION_REALTIME_SHUTDOWN_GRACE_MS: '',
    })
    expect(result.status).toBe(0)
    const line = (result.stdout + result.stderr).split('\n').find(l => l.startsWith('RT='))
    const cfg = JSON.parse(line!.slice('RT='.length))
    expect(cfg.enabled).toBe(false)
    expect(cfg.heartbeatMs).toBe(20000)
    expect(cfg.maxBufferBytes).toBe(65536)
  })

  it('accepts every closed-range boundary value', () => {
    const result = loadConfigWith({
      NOTIFICATION_REALTIME_HEARTBEAT_MS: '5000',
      NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_USER: '1',
      NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_IP: '200',
      NOTIFICATION_REALTIME_MAX_CONNECTIONS: '100000',
      NOTIFICATION_REALTIME_MAX_BUFFER_BYTES: '1048576',
      NOTIFICATION_REALTIME_CONNECT_RATE_LIMIT_MAX: '1000',
      NOTIFICATION_REALTIME_SHUTDOWN_GRACE_MS: '9000',
      NOTIFICATION_REALTIME_ENABLED: 'false',
    })
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
    expect(result.status).toBe(0)
  })

  it('rejects out-of-range integers with a non-zero exit (no silent clamp)', () => {
    const cases: Array<[string, string]> = [
      ['NOTIFICATION_REALTIME_HEARTBEAT_MS', '4999'],
      ['NOTIFICATION_REALTIME_HEARTBEAT_MS', '60001'],
      ['NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_USER', '0'],
      ['NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_USER', '21'],
      ['NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_IP', '201'],
      ['NOTIFICATION_REALTIME_MAX_CONNECTIONS', '0'],
      ['NOTIFICATION_REALTIME_MAX_BUFFER_BYTES', '16383'],
      ['NOTIFICATION_REALTIME_CONNECT_RATE_LIMIT_MAX', '0'],
      ['NOTIFICATION_REALTIME_CONNECT_RATE_LIMIT_MAX', '1001'],
      ['NOTIFICATION_REALTIME_SHUTDOWN_GRACE_MS', '999'],
      ['NOTIFICATION_REALTIME_SHUTDOWN_GRACE_MS', '9001'],
    ]
    for (const [key, value] of cases) {
      const result = loadConfigWith({ [key]: value })
      expect(result.status, `${key}=${value} should be rejected`).toBe(1)
    }
  })

  it('rejects non-decimal / non-integer strings and invalid booleans', () => {
    const cases: Array<[string, string]> = [
      ['NOTIFICATION_REALTIME_HEARTBEAT_MS', '12.5'],
      ['NOTIFICATION_REALTIME_HEARTBEAT_MS', 'abc'],
      ['NOTIFICATION_REALTIME_HEARTBEAT_MS', '20_000'],
      ['NOTIFICATION_REALTIME_MAX_CONNECTIONS', '-5'],
      ['NOTIFICATION_REALTIME_ENABLED', 'yes'],
      ['NOTIFICATION_REALTIME_ENABLED', '1'],
      ['NOTIFICATION_REALTIME_ENABLED', 'TRUE'],
    ]
    for (const [key, value] of cases) {
      const result = loadConfigWith({ [key]: value })
      expect(result.status, `${key}=${value} should be rejected`).toBe(1)
    }
  })
})

describe('CHK-CFG-002 — realtime=true requires notification=true (spec 8.1 / AC-RT-014)', () => {
  it('refuses NOTIFICATION_REALTIME_ENABLED=true with NOTIFICATION_ENABLED=false', () => {
    const result = loadConfigWith({
      NOTIFICATION_REALTIME_ENABLED: 'true',
      NOTIFICATION_ENABLED: 'false',
    })
    expect(result.status).toBe(1)
    const output = result.stderr + result.stdout
    expect(output).toContain('NOTIFICATION_REALTIME_ENABLED')
    expect(output).toContain('NOTIFICATION_ENABLED')
  })

  it('refuses NOTIFICATION_REALTIME_ENABLED=true when notification is unset (default false)', () => {
    const result = loadConfigWith({ NOTIFICATION_REALTIME_ENABLED: 'true' })
    expect(result.status).toBe(1)
  })

  it('boots with NOTIFICATION_REALTIME_ENABLED=true and NOTIFICATION_ENABLED=true', () => {
    const result = loadConfigWith({
      NOTIFICATION_REALTIME_ENABLED: 'true',
      NOTIFICATION_ENABLED: 'true',
    })
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
    expect(result.status).toBe(0)
  })

  it('boots with realtime unset / false regardless of notification flag (default closed)', () => {
    const off = loadConfigWith({ NOTIFICATION_ENABLED: 'true' })
    expect(off.stdout + off.stderr).toContain('CONFIG_OK')
    expect(off.status).toBe(0)
  })
})
