import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const VALID_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

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
})
