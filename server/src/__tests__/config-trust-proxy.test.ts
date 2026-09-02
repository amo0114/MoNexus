import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SERVER_ROOT = path.resolve(__dirname, '..', '..')
const ROOT = path.resolve(SERVER_ROOT, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-prod-env.sh')

const VALID_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const VALID_ABUSE_HASH_KEY = Buffer.alloc(32, 8).toString('base64')

const DEV_BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_SECRET: 'a-sufficiently-long-test-secret-32chars!!',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
}

const PROD_BASE_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  COOKIE_SECURE: 'true',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_SECRET: 'a-sufficiently-long-production-secret!!',
  FRONTEND_ORIGIN: 'https://shop.example.com',
  METRICS_TOKEN: 'metrics-token-for-test',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_BUCKET: 'monexus-uploads',
  STORAGE_ACCESS_KEY: 'ak',
  STORAGE_SECRET_KEY: 'sk',
  DELIVERY_STORAGE_BUCKET: 'monexus-files',
  DELIVERY_STORAGE_PUBLIC_ENDPOINT: 'https://shop.example.com',
  MFA_ENCRYPTION_KEY: VALID_MFA_ENCRYPTION_KEY,
  ABUSE_PROTECTION_MODE: 'enforce',
  ABUSE_HASH_KEY: VALID_ABUSE_HASH_KEY,
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-production-guard-test',
  TURNSTILE_ALLOWED_HOSTNAMES: 'shop.example.com',
  REDIS_ENABLED: 'true',
  REDIS_REQUIRED: 'true',
  WEBHOOK_SECRET_ENC_KEY: 'a'.repeat(64),
  TRUST_PROXY: '1',
  DEPLOY_TOPOLOGY: 'nginx',
}

function loadConfigWith(
  overrides: Record<string, string | undefined>,
  base: Record<string, string> = DEV_BASE_ENV,
) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) env[key] = value
  }
  return spawnSync(
    'npx',
    ['tsx', '-e', "import('./src/config/index.js').then((m) => { console.log('CFG=' + JSON.stringify({ trustProxy: m.config.trustProxy, deployTopology: m.config.deployTopology })); process.exit(0) })"],
    { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 },
  )
}

function spawnText(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function parseCfg(result: ReturnType<typeof spawnSync>) {
  const line = spawnText(result).split('\n').find((entry: string) => entry.startsWith('CFG='))
  if (!line) return null
  return JSON.parse(line.slice('CFG='.length)) as { trustProxy: number; deployTopology: string }
}

describe('TRUST_PROXY strict integer schema', () => {
  it('defaults empty/unset to 0 in non-production', () => {
    const unset = loadConfigWith({ TRUST_PROXY: undefined })
    expect(unset.status, spawnText(unset)).toBe(0)
    expect(parseCfg(unset)).toEqual({ trustProxy: 0, deployTopology: 'nginx' })

    const empty = loadConfigWith({ TRUST_PROXY: '' })
    expect(empty.status, spawnText(empty)).toBe(0)
    expect(parseCfg(empty)?.trustProxy).toBe(0)
  })

  it('accepts canonical 0/1/2', () => {
    for (const value of ['0', '1', '2']) {
      const result = loadConfigWith({ TRUST_PROXY: value })
      expect(result.status, `${value}: ${spawnText(result)}`).toBe(0)
      expect(parseCfg(result)?.trustProxy).toBe(Number(value))
    }
  })

  it('rejects boolean true/false so they cannot coerce to 1/0', () => {
    for (const value of ['true', 'false']) {
      const result = loadConfigWith({ TRUST_PROXY: value })
      expect(result.status, `TRUST_PROXY=${value} must fail`).toBe(1)
      expect(spawnText(result)).toMatch(/TRUST_PROXY/)
    }
  })

  it('rejects negatives, decimals, whitespace, leading zeros, and scientific notation', () => {
    for (const value of ['-1', '1.5', ' 1', '1 ', '01', '1e2', '2.0', '+1', '3']) {
      const result = loadConfigWith({ TRUST_PROXY: value })
      expect(result.status, `TRUST_PROXY=${JSON.stringify(value)} must fail`).toBe(1)
    }
  })

  it('parses deploy topology including cloudflare_openresty_nginx', () => {
    const result = loadConfigWith({
      TRUST_PROXY: '2',
      DEPLOY_TOPOLOGY: 'cloudflare_openresty_nginx',
    })
    expect(result.status, spawnText(result)).toBe(0)
    expect(parseCfg(result)).toEqual({
      trustProxy: 2,
      deployTopology: 'cloudflare_openresty_nginx',
    })
  })

  it('refuses TRUST_PROXY=0 in production', () => {
    const missing = loadConfigWith({ TRUST_PROXY: undefined }, PROD_BASE_ENV)
    expect(missing.status).toBe(1)
    expect(spawnText(missing)).toMatch(/TRUST_PROXY/)

    const zero = loadConfigWith({ TRUST_PROXY: '0' }, { ...PROD_BASE_ENV, TRUST_PROXY: '0' })
    expect(zero.status).toBe(1)
    expect(spawnText(zero)).toMatch(/TRUST_PROXY/)

    const ok = loadConfigWith({ TRUST_PROXY: '2' }, { ...PROD_BASE_ENV, TRUST_PROXY: '2' })
    expect(ok.status, spawnText(ok)).toBe(0)
    expect(parseCfg(ok)?.trustProxy).toBe(2)
  })
})

describe('check-prod-env.sh trusted proxy topology', () => {
  function writeEnv(extras: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'monexus-trust-proxy-env-'))
    const file = path.join(dir, '.env')
    const values: Record<string, string> = {
      POSTGRES_USER: 'monexus',
      POSTGRES_PASSWORD: 'test-password',
      POSTGRES_DB: 'monexus',
      JWT_SECRET: 'a-sufficiently-long-production-secret!!',
      MFA_ENCRYPTION_KEY: VALID_MFA_ENCRYPTION_KEY,
      ABUSE_PROTECTION_MODE: 'enforce',
      ABUSE_HASH_KEY: VALID_ABUSE_HASH_KEY,
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: 'turnstile-secret-for-preflight',
      TURNSTILE_ALLOWED_HOSTNAMES: 'shop.example.com',
      REDIS_ENABLED: 'true',
      REDIS_REQUIRED: 'true',
      REDIS_URL: 'redis://localhost:6379',
      LEGAL_PAGES_ENABLED: 'true',
      LEGAL_PAGES_ENFORCEMENT: 'enforce',
      FRONTEND_ORIGIN: 'https://shop.example.com',
      COOKIE_SECURE: 'true',
      USER_STATUS_CACHE_TTL_SEC: '60',
      STORAGE_ENDPOINT: 'https://minio.example.com',
      STORAGE_BUCKET: 'monexus-uploads',
      STORAGE_ACCESS_KEY: 'ak',
      STORAGE_SECRET_KEY: 'sk',
      STORAGE_PUBLIC_URL_BASE: 'https://cdn.example.com',
      DELIVERY_STORAGE_BUCKET: 'monexus-files',
      DELIVERY_STORAGE_PUBLIC_ENDPOINT: 'https://files.example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'secret',
      SMTP_FROM: 'ops@example.com',
      ALERT_EMAIL_TO: 'alerts@example.com',
      WEBHOOK_SECRET_ENC_KEY: 'a'.repeat(64),
      METRICS_TOKEN: 'metrics-token-for-preflight-at-least-32',
      POINT_VALUE_POLICY_MODE: 'off',
      DEPLOY_TOPOLOGY: 'nginx',
      TRUST_PROXY: '1',
      ...extras,
    }
    writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'))
    return { dir, file }
  }

  function runPreflight(envFile: string, mode: 'production' | 'staging' = 'production') {
    return spawnSync('bash', [SCRIPT, '--mode', mode, '--env-file', envFile, '--no-backup'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  const cases: Array<{
    name: string
    extras: Record<string, string>
    mode?: 'production' | 'staging'
    ok: boolean
    needle?: string
  }> = [
    { name: 'nginx + 1', extras: { DEPLOY_TOPOLOGY: 'nginx', TRUST_PROXY: '1' }, ok: true },
    { name: 'caddy + 2', extras: { DEPLOY_TOPOLOGY: 'caddy', TRUST_PROXY: '2' }, ok: true },
    {
      name: 'cloudflare_openresty_nginx + 2',
      extras: { DEPLOY_TOPOLOGY: 'cloudflare_openresty_nginx', TRUST_PROXY: '2' },
      ok: true,
    },
    {
      name: 'nginx + 2 mismatch',
      extras: { DEPLOY_TOPOLOGY: 'nginx', TRUST_PROXY: '2' },
      ok: false,
      needle: 'TRUST_PROXY',
    },
    {
      name: 'cloudflare_openresty_nginx + 1 mismatch',
      extras: { DEPLOY_TOPOLOGY: 'cloudflare_openresty_nginx', TRUST_PROXY: '1' },
      ok: false,
      needle: 'TRUST_PROXY',
    },
    {
      name: 'boolean true is illegal',
      extras: { TRUST_PROXY: 'true' },
      ok: false,
      needle: 'TRUST_PROXY',
    },
    {
      name: 'boolean false is illegal',
      extras: { TRUST_PROXY: 'false' },
      ok: false,
      needle: 'TRUST_PROXY',
    },
    {
      name: 'unknown topology',
      extras: { DEPLOY_TOPOLOGY: 'cloudflare' },
      ok: false,
      needle: 'DEPLOY_TOPOLOGY',
    },
    {
      name: 'mismatch is enforced even when realtime is off',
      extras: {
        NOTIFICATION_REALTIME_ENABLED: 'false',
        DEPLOY_TOPOLOGY: 'nginx',
        TRUST_PROXY: '2',
      },
      ok: false,
      needle: 'TRUST_PROXY',
    },
    {
      name: 'staging caddy + 2',
      extras: { DEPLOY_TOPOLOGY: 'caddy', TRUST_PROXY: '2', MONEXUS_DEPLOY_ENV: 'staging' },
      mode: 'staging',
      ok: true,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const env = writeEnv(testCase.extras)
      try {
        const result = runPreflight(env.file, testCase.mode ?? 'production')
        if (testCase.ok) {
          expect(result.status, spawnText(result)).toBe(0)
        } else {
          expect(result.status, spawnText(result)).toBe(1)
          if (testCase.needle) {
            expect(spawnText(result)).toContain(testCase.needle)
          }
        }
      } finally {
        rmSync(env.dir, { recursive: true, force: true })
      }
    })
  }
})
