import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const VALID_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const VALID_ABUSE_HASH_KEY = Buffer.alloc(32, 8).toString('base64')

/**
 * P5 复审 P0 回归：生产缺私有交付桶配置必须**拒绝启动**——回退是进程内存
 * 存储，上传"成功"的付费文件会在重启后蒸发。config 模块在 import 时校验并
 * process.exit(1)，因此用子进程验证。
 */

const SERVER_ROOT = path.resolve(__dirname, '..', '..')

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
  // P7b：商家 webhook 签名密钥的静态加密密钥（生产必配，64 位 hex）。
  WEBHOOK_SECRET_ENC_KEY: 'a'.repeat(64),
}

function loadConfigWith(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [key, value] of Object.entries({ ...PROD_BASE_ENV, ...overrides })) {
    if (value !== undefined) env[key] = value
  }
  return spawnSync(
    'npx',
    ['tsx', '-e', "import('./src/config/index.js').then(() => { console.log('CONFIG_OK'); process.exit(0) })"],
    { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 }
  )
}

describe('production config guards for the private delivery bucket', () => {
  it('boots with a complete delivery configuration', () => {
    const result = loadConfigWith({})
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
    expect(result.status).toBe(0)
  })

  it('refuses to start when DELIVERY_STORAGE_BUCKET is missing', () => {
    const result = loadConfigWith({ DELIVERY_STORAGE_BUCKET: undefined })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('DELIVERY_STORAGE_BUCKET')
  })

  it('refuses to start when DELIVERY_STORAGE_PUBLIC_ENDPOINT is missing', () => {
    const result = loadConfigWith({ DELIVERY_STORAGE_PUBLIC_ENDPOINT: undefined })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('DELIVERY_STORAGE')
  })

  it('refuses an http DELIVERY_STORAGE_PUBLIC_ENDPOINT in production (P1 regression)', () => {
    // presign URL 直接暴露给买家浏览器；check-prod-env.sh 只覆盖 compose
    // 预检，直接启动会绕过——https 必须在配置层强制。
    const result = loadConfigWith({ DELIVERY_STORAGE_PUBLIC_ENDPOINT: 'http://shop.example.com' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('https')
  })

  it('refuses a delivery bucket named like the public bucket (any environment)', () => {
    const result = loadConfigWith({ DELIVERY_STORAGE_BUCKET: 'monexus-uploads' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('must differ')
  })
})

describe('production config guard for the MFA encryption key', () => {
  it('refuses to start when MFA_ENCRYPTION_KEY is missing', () => {
    const result = loadConfigWith({ MFA_ENCRYPTION_KEY: undefined })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('MFA_ENCRYPTION_KEY')
  })

  it('refuses a non-canonical base64 MFA_ENCRYPTION_KEY', () => {
    const result = loadConfigWith({ MFA_ENCRYPTION_KEY: 'not base64!' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('MFA_ENCRYPTION_KEY')
  })

  it('refuses an MFA_ENCRYPTION_KEY that does not decode to 32 bytes', () => {
    const result = loadConfigWith({ MFA_ENCRYPTION_KEY: Buffer.alloc(31, 7).toString('base64') })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('32 bytes')
  })
})

describe('production config guards for registration abuse protection (SPEC-RAP-001)', () => {
  it('refuses ABUSE_PROTECTION_MODE=off in production', () => {
    const result = loadConfigWith({ ABUSE_PROTECTION_MODE: 'off' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('ABUSE_PROTECTION_MODE')
  })

  it('requires an independent canonical 32-byte ABUSE_HASH_KEY', () => {
    const missing = loadConfigWith({ ABUSE_HASH_KEY: undefined })
    expect(missing.status).toBe(1)
    expect(missing.stderr + missing.stdout).toContain('ABUSE_HASH_KEY')

    const malformed = loadConfigWith({ ABUSE_HASH_KEY: 'not canonical base64' })
    expect(malformed.status).toBe(1)
    expect(malformed.stderr + malformed.stdout).toContain('ABUSE_HASH_KEY')
  })

  it('requires Turnstile site/secret/hostname configuration and rejects URL-shaped hostnames', () => {
    const missing = loadConfigWith({ TURNSTILE_SECRET_KEY: undefined })
    expect(missing.status).toBe(1)
    expect(missing.stderr + missing.stdout).toContain('TURNSTILE')

    const malformed = loadConfigWith({ TURNSTILE_ALLOWED_HOSTNAMES: 'https://shop.example.com' })
    expect(malformed.status).toBe(1)
    expect(malformed.stderr + malformed.stdout).toContain('TURNSTILE_ALLOWED_HOSTNAMES')
  })

  it('requires a shared enabled and required Redis dependency in production', () => {
    const disabled = loadConfigWith({ REDIS_ENABLED: 'false' })
    expect(disabled.status).toBe(1)
    expect(disabled.stderr + disabled.stdout).toContain('REDIS_ENABLED')

    const optional = loadConfigWith({ REDIS_REQUIRED: 'false' })
    expect(optional.status).toBe(1)
    expect(optional.stderr + optional.stdout).toContain('REDIS_REQUIRED')
  })
})

describe('production config guards for auto-provision webhooks (P7b)', () => {
  it('refuses to start when WEBHOOK_SECRET_ENC_KEY is missing in production', () => {
    const result = loadConfigWith({ WEBHOOK_SECRET_ENC_KEY: undefined })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('WEBHOOK_SECRET_ENC_KEY')
  })

  it('refuses a malformed (non-64-hex) WEBHOOK_SECRET_ENC_KEY in any environment', () => {
    const result = loadConfigWith({ WEBHOOK_SECRET_ENC_KEY: 'too-short' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('64 hex')
  })

  it('refuses AUTO_PROVISION_ALLOW_INSECURE_TARGETS in production (SSRF kill-switch)', () => {
    const result = loadConfigWith({ AUTO_PROVISION_ALLOW_INSECURE_TARGETS: 'true' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('AUTO_PROVISION_ALLOW_INSECURE_TARGETS')
  })
})

describe('production config guards for legal pages & consent (SPEC-LEGAL-001)', () => {
  it('boots in production with legal pages enabled and enforced', () => {
    const result = loadConfigWith({ LEGAL_PAGES_ENABLED: 'true', LEGAL_PAGES_ENFORCEMENT: 'enforce' })
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
  })

  it('refuses LEGAL_PAGES_ENFORCEMENT=enforce without LEGAL_PAGES_ENABLED (contradiction)', () => {
    const result = loadConfigWith({ LEGAL_PAGES_ENFORCEMENT: 'enforce' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('LEGAL_PAGES_ENFORCEMENT')
  })

  it('refuses LEGAL_PAGES_ENABLED without enforce in production', () => {
    const result = loadConfigWith({ LEGAL_PAGES_ENABLED: 'true' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('LEGAL_PAGES_ENFORCEMENT')
  })

  it('refuses LEGAL_PAGES_FIXTURE_PATH in production (test escape hatch)', () => {
    const result = loadConfigWith({
      LEGAL_PAGES_ENABLED: 'true',
      LEGAL_PAGES_ENFORCEMENT: 'enforce',
      LEGAL_PAGES_FIXTURE_PATH: '/tmp/legal-fixtures',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('LEGAL_PAGES_FIXTURE_PATH')
  })
})

describe('ops scripts cover both buckets (P1 regression)', () => {
  it('backup.sh mirrors the delivery bucket and restore-objects-check.sh restores it', async () => {
    const { readFile } = await import('node:fs/promises')
    const backup = await readFile(path.resolve(SERVER_ROOT, '..', 'scripts', 'backup.sh'), 'utf8')
    expect(backup).toContain('DELIVERY_STORAGE_BUCKET')
    expect(backup).toContain('/backup/delivery')

    const restore = await readFile(path.resolve(SERVER_ROOT, '..', 'scripts', 'restore-objects-check.sh'), 'utf8')
    expect(restore).toContain('DELIVERY_STORAGE_BUCKET')
    expect(restore).toContain('/restore/delivery')

    const preflight = await readFile(path.resolve(SERVER_ROOT, '..', 'scripts', 'check-prod-env.sh'), 'utf8')
    expect(preflight).toContain('require_value DELIVERY_STORAGE_BUCKET')
    expect(preflight).toContain('require_url DELIVERY_STORAGE_PUBLIC_ENDPOINT')
  })

  it('makes MinIO credentials available to one-shot backup and restore clients', async () => {
    const { readFile } = await import('node:fs/promises')
    const compose = await readFile(path.resolve(SERVER_ROOT, '..', 'docker-compose.prod.yml'), 'utf8')
    const minioInit = compose.slice(compose.indexOf('  minio-init:'), compose.indexOf('  mailpit:'))

    expect(minioInit).toContain('STORAGE_ACCESS_KEY: ${STORAGE_ACCESS_KEY}')
    expect(minioInit).toContain('STORAGE_SECRET_KEY: ${STORAGE_SECRET_KEY}')
    expect(minioInit).toContain('STORAGE_BUCKET: ${STORAGE_BUCKET}')
    expect(minioInit).toContain('DELIVERY_STORAGE_BUCKET: ${DELIVERY_STORAGE_BUCKET:-monexus-files}')
    expect(minioInit).toContain('"$${STORAGE_ACCESS_KEY}" "$${STORAGE_SECRET_KEY}"')
    expect(minioInit).not.toContain('http://minio:9000 ${STORAGE_ACCESS_KEY}')
  })
})
