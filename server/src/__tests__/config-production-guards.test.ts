import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

describe('recharge isProductionDeploy isolation matrix', () => {
  it('boots production+production when RECHARGE_MODE is disabled by default', () => {
    const result = loadConfigWith({})
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
  })

  it('refuses RECHARGE_MODE=sandbox on production+production', () => {
    const result = loadConfigWith({ RECHARGE_MODE: 'sandbox' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('RECHARGE_MODE=sandbox')
  })

  it('refuses a registered simulator on production+production', () => {
    const result = loadConfigWith({
      PAYMENT_REGISTERED_PROVIDERS: 'simulator',
      PAYMENT_ENABLED_PROVIDERS: 'simulator',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toMatch(/simulator/)
  })

  it('allows sandbox and simulator on production+staging without weakening NODE_ENV checks', () => {
    const ok = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'sandbox',
      PAYMENT_REGISTERED_PROVIDERS: 'simulator',
      PAYMENT_ENABLED_PROVIDERS: 'simulator',
    })
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(ok.stdout + ok.stderr).toContain('CONFIG_OK')

    const abuse = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'sandbox',
      ABUSE_PROTECTION_MODE: 'off',
    })
    expect(abuse.status).toBe(1)
    expect(abuse.stderr + abuse.stdout).toContain('ABUSE_PROTECTION_MODE')
  })

  it('treats a missing MONEXUS_DEPLOY_ENV as production for sandbox isolation', () => {
    const result = loadConfigWith({
      MONEXUS_DEPLOY_ENV: undefined,
      RECHARGE_MODE: 'sandbox',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('RECHARGE_MODE=sandbox')
  })

  it('allows sandbox when NODE_ENV=development even if deploy env is production', () => {
    const result = loadConfigWith({
      NODE_ENV: 'development',
      MONEXUS_DEPLOY_ENV: 'production',
      RECHARGE_MODE: 'sandbox',
      PAYMENT_REGISTERED_PROVIDERS: 'simulator',
      PAYMENT_ENABLED_PROVIDERS: 'simulator',
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
  })

  it('requires enabled providers to be a subset of registered', () => {
    const result = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      PAYMENT_REGISTERED_PROVIDERS: 'paypal',
      PAYMENT_ENABLED_PROVIDERS: 'stripe',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('PAYMENT_ENABLED_PROVIDERS')
  })

  it('keeps a historical provider registered after it is removed from enabled', () => {
    const result = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'sandbox',
      PAYMENT_REGISTERED_PROVIDERS: 'stripe,paypal',
      PAYMENT_ENABLED_PROVIDERS: 'paypal',
      PAYPAL_MODE: 'sandbox',
      PAYPAL_WEBHOOK_ID: 'wh_id',
      PAYPAL_API_BASE_URL: 'https://api-m.sandbox.paypal.com',
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
  })

  it('refuses HTTP webhook public URLs and live Stripe test keys', () => {
    const http = loadConfigWith({
      PAYMENT_WEBHOOK_PUBLIC_BASE_URL: 'http://shop.example.com',
    })
    expect(http.status).toBe(1)
    expect(http.stderr + http.stdout).toContain('https')

    const testKey = loadConfigWith({
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_test_123',
    })
    expect(testKey.status).toBe(1)
    expect(testKey.stderr + testKey.stdout).toMatch(/test credentials/)

    const restrictedKey = loadConfigWith({
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'rk_test_123',
    })
    expect(restrictedKey.status).toBe(1)
    expect(restrictedKey.stderr + restrictedKey.stdout).toMatch(/test credentials/)
  })

  it('refuses sandbox recharge with an enabled live provider and keeps registered-only live adapters', () => {
    const enabledLive = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'sandbox',
      PAYMENT_REGISTERED_PROVIDERS: 'stripe',
      PAYMENT_ENABLED_PROVIDERS: 'stripe',
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    })
    expect(enabledLive.status).toBe(1)
    expect(enabledLive.stderr + enabledLive.stdout).toMatch(/cannot enable live provider stripe/)

    const historicalLive = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'sandbox',
      PAYMENT_REGISTERED_PROVIDERS: 'stripe,paypal',
      PAYMENT_ENABLED_PROVIDERS: 'paypal',
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      PAYPAL_MODE: 'sandbox',
      PAYPAL_WEBHOOK_ID: 'wh_id',
      PAYPAL_API_BASE_URL: 'https://api-m.sandbox.paypal.com',
    })
    expect(historicalLive.status, historicalLive.stdout + historicalLive.stderr).toBe(0)
    expect(historicalLive.stdout + historicalLive.stderr).toContain('CONFIG_OK')
  })

  it('refuses live recharge when an enabled provider is test, sandbox, or simulator', () => {
    const enc = Buffer.alloc(32, 9).toString('base64')
    const stripeTest = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'live',
      PAYMENT_EVENT_ENCRYPTION_KEY: enc,
      PAYMENT_REGISTERED_PROVIDERS: 'stripe',
      PAYMENT_ENABLED_PROVIDERS: 'stripe',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    })
    expect(stripeTest.status).toBe(1)
    expect(stripeTest.stderr + stripeTest.stdout).toMatch(/cannot enable test provider stripe/)

    const simulator = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'live',
      PAYMENT_EVENT_ENCRYPTION_KEY: enc,
      PAYMENT_REGISTERED_PROVIDERS: 'simulator',
      PAYMENT_ENABLED_PROVIDERS: 'simulator',
    })
    expect(simulator.status).toBe(1)
    expect(simulator.stderr + simulator.stdout).toMatch(/cannot enable sandbox provider simulator/)
  })

  it('requires a canonical PAYMENT_EVENT_ENCRYPTION_KEY when live and ignores it when disabled', () => {
    const missing = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'live',
    })
    expect(missing.status).toBe(1)
    expect(missing.stderr + missing.stdout).toContain('PAYMENT_EVENT_ENCRYPTION_KEY')

    const malformed = loadConfigWith({
      PAYMENT_EVENT_ENCRYPTION_KEY: 'not-canonical-base64',
    })
    expect(malformed.status).toBe(1)
    expect(malformed.stderr + malformed.stdout).toContain('PAYMENT_EVENT_ENCRYPTION_KEY')

    const disabled = loadConfigWith({})
    expect(disabled.status, disabled.stdout + disabled.stderr).toBe(0)
    expect(disabled.stdout + disabled.stderr).toContain('CONFIG_OK')
  })

  it('does not treat WECHAT_PAY_APIV3_KEY as WeChat webhook verify material', () => {
    const enc = Buffer.alloc(32, 9).toString('base64')
    const missingPlatformKey = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      RECHARGE_MODE: 'live',
      PAYMENT_EVENT_ENCRYPTION_KEY: enc,
      PAYMENT_REGISTERED_PROVIDERS: 'wechat_pay',
      PAYMENT_ENABLED_PROVIDERS: 'wechat_pay',
      WECHAT_PAY_MODE: 'live',
      WECHAT_PAY_APIV3_KEY: 'apiv3-decrypt-key-only',
    })
    expect(missingPlatformKey.status).toBe(1)
    expect(missingPlatformKey.stderr + missingPlatformKey.stdout).toContain('WECHAT_PAY_PLATFORM_PUBLIC_KEY')
    expect(missingPlatformKey.stderr + missingPlatformKey.stdout).not.toMatch(/CONFIG_OK/)
  })
})

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

  it('defaults POINT_VALUE_POLICY_MODE to off and rejects an illegal value', () => {
    const ok = loadConfigWith({})
    expect(ok.status).toBe(0)
    expect(ok.stdout + ok.stderr).toContain('CONFIG_OK')

    const bad = loadConfigWith({ POINT_VALUE_POLICY_MODE: 'on' })
    expect(bad.status).toBe(1)
    expect(bad.stderr + bad.stdout).toContain('POINT_VALUE_POLICY_MODE')
  })

  it('boots in production when POINT_VALUE_POLICY_MODE is off', () => {
    const result = loadConfigWith({ POINT_VALUE_POLICY_MODE: 'off' })
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('CONFIG_OK')
  })

  it('refuses POINT_VALUE_POLICY_MODE=shadow in production', () => {
    const result = loadConfigWith({ POINT_VALUE_POLICY_MODE: 'shadow' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('POINT_VALUE_POLICY_MODE')
    expect(result.stderr + result.stdout).toContain('off')
  })

  it('refuses POINT_VALUE_POLICY_MODE=enforce in production', () => {
    const result = loadConfigWith({ POINT_VALUE_POLICY_MODE: 'enforce' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('POINT_VALUE_POLICY_MODE')
    expect(result.stderr + result.stdout).toContain('off')
  })

  it('keeps production-grade checks but allows shadow/enforce when MONEXUS_DEPLOY_ENV=staging', () => {
    const shadow = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      POINT_VALUE_POLICY_MODE: 'shadow',
    })
    expect(shadow.status).toBe(0)
    expect(shadow.stdout + shadow.stderr).toContain('CONFIG_OK')

    const enforce = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      POINT_VALUE_POLICY_MODE: 'enforce',
    })
    expect(enforce.status).toBe(0)
    expect(enforce.stdout + enforce.stderr).toContain('CONFIG_OK')
  })

  it('still refuses ABUSE_PROTECTION_MODE=off under MONEXUS_DEPLOY_ENV=staging', () => {
    const result = loadConfigWith({
      MONEXUS_DEPLOY_ENV: 'staging',
      POINT_VALUE_POLICY_MODE: 'shadow',
      ABUSE_PROTECTION_MODE: 'off',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('ABUSE_PROTECTION_MODE')
  })

  it('treats unset MONEXUS_DEPLOY_ENV as production for the value-policy gate', () => {
    const result = loadConfigWith({
      MONEXUS_DEPLOY_ENV: undefined,
      POINT_VALUE_POLICY_MODE: 'shadow',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('POINT_VALUE_POLICY_MODE')
  })

  it('rejects an illegal MONEXUS_DEPLOY_ENV', () => {
    const result = loadConfigWith({ MONEXUS_DEPLOY_ENV: 'lab' })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('MONEXUS_DEPLOY_ENV')
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

describe('production Compose legal configuration boundary', () => {
  it('passes every legal setting into the server and makes production intent explicit in preflight', async () => {
    const { readFile } = await import('node:fs/promises')
    const compose = await readFile(path.resolve(SERVER_ROOT, '..', 'docker-compose.prod.yml'), 'utf8')
    const server = compose.slice(compose.indexOf('  server:'), compose.indexOf('  redis:'))
    const preflight = await readFile(path.resolve(SERVER_ROOT, '..', 'scripts', 'check-prod-env.sh'), 'utf8')

    expect(server).toContain('LEGAL_PAGES_ENABLED: ${LEGAL_PAGES_ENABLED:-false}')
    expect(server).toContain('LEGAL_PAGES_ENFORCEMENT: ${LEGAL_PAGES_ENFORCEMENT:-off}')
    expect(server).toContain('LEGAL_PAGES_FIXTURE_PATH: ${LEGAL_PAGES_FIXTURE_PATH:-}')
    expect(preflight).toContain('require_value LEGAL_PAGES_ENABLED')
    expect(preflight).toContain('require_value LEGAL_PAGES_ENFORCEMENT')
    expect(preflight).toContain('LEGAL_PAGES_FIXTURE_PATH must be empty in production')
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

describe('check-prod-env.sh POINT_VALUE_POLICY_MODE', () => {
  const ROOT = path.resolve(SERVER_ROOT, '..')
  const SCRIPT = path.join(ROOT, 'scripts', 'check-prod-env.sh')

  function writeEnv(mode: string, extras: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'monexus-vp-env-'))
    const file = path.join(dir, '.env')
    writeFileSync(file, [
      'POSTGRES_USER=monexus',
      'POSTGRES_PASSWORD=test-password',
      'POSTGRES_DB=monexus',
      'JWT_SECRET=a-sufficiently-long-production-secret!!',
      `MFA_ENCRYPTION_KEY=${VALID_MFA_ENCRYPTION_KEY}`,
      'ABUSE_PROTECTION_MODE=enforce',
      `ABUSE_HASH_KEY=${VALID_ABUSE_HASH_KEY}`,
      'TURNSTILE_SITE_KEY=1x00000000000000000000AA',
      'TURNSTILE_SECRET_KEY=turnstile-secret-for-preflight',
      'TURNSTILE_ALLOWED_HOSTNAMES=shop.example.com',
      'REDIS_ENABLED=true',
      'REDIS_REQUIRED=true',
      'REDIS_URL=redis://localhost:6379',
      'LEGAL_PAGES_ENABLED=true',
      'LEGAL_PAGES_ENFORCEMENT=enforce',
      'FRONTEND_ORIGIN=https://shop.example.com',
      'COOKIE_SECURE=true',
      'USER_STATUS_CACHE_TTL_SEC=60',
      'STORAGE_ENDPOINT=https://minio.example.com',
      'STORAGE_BUCKET=monexus-uploads',
      'STORAGE_ACCESS_KEY=ak',
      'STORAGE_SECRET_KEY=sk',
      'STORAGE_PUBLIC_URL_BASE=https://cdn.example.com',
      'DELIVERY_STORAGE_BUCKET=monexus-files',
      'DELIVERY_STORAGE_PUBLIC_ENDPOINT=https://files.example.com',
      'SMTP_HOST=smtp.example.com',
      'SMTP_PORT=587',
      'SMTP_SECURE=false',
      'SMTP_USER=mailer',
      'SMTP_PASS=secret',
      'SMTP_FROM=ops@example.com',
      'ALERT_EMAIL_TO=alerts@example.com',
      `WEBHOOK_SECRET_ENC_KEY=${'a'.repeat(64)}`,
      'METRICS_TOKEN=metrics-token-for-preflight-at-least-32',
      `POINT_VALUE_POLICY_MODE=${mode}`,
      ...Object.entries(extras).map(([key, value]) => `${key}=${value}`),
    ].join('\n'))
    return { dir, file }
  }

  function runPreflight(envFile: string, mode: 'production' | 'staging') {
    return spawnSync('bash', [SCRIPT, '--mode', mode, '--env-file', envFile, '--no-backup'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  it('accepts off in production and rejects shadow/enforce', () => {
    const off = writeEnv('off')
    const shadow = writeEnv('shadow')
    const enforce = writeEnv('enforce')
    const invalid = writeEnv('on')
    try {
      const offResult = runPreflight(off.file, 'production')
      expect(offResult.status).toBe(0)

      const shadowResult = runPreflight(shadow.file, 'production')
      expect(shadowResult.status).toBe(1)
      expect(shadowResult.stderr + shadowResult.stdout).toContain('POINT_VALUE_POLICY_MODE')

      const enforceResult = runPreflight(enforce.file, 'production')
      expect(enforceResult.status).toBe(1)
      expect(enforceResult.stderr + enforceResult.stdout).toContain('POINT_VALUE_POLICY_MODE')

      const invalidResult = runPreflight(invalid.file, 'production')
      expect(invalidResult.status).toBe(1)
      expect(invalidResult.stderr + invalidResult.stdout).toContain('POINT_VALUE_POLICY_MODE')
    } finally {
      rmSync(off.dir, { recursive: true, force: true })
      rmSync(shadow.dir, { recursive: true, force: true })
      rmSync(enforce.dir, { recursive: true, force: true })
      rmSync(invalid.dir, { recursive: true, force: true })
    }
  })

  it('allows shadow in staging for backtests', () => {
    const shadow = writeEnv('shadow', { MONEXUS_DEPLOY_ENV: 'staging' })
    try {
      const result = runPreflight(shadow.file, 'staging')
      expect(result.status).toBe(0)
    } finally {
      rmSync(shadow.dir, { recursive: true, force: true })
    }
  })

  it('requires a valid production alert email recipient', () => {
    const missing = writeEnv('off', { ALERT_EMAIL_TO: '' })
    const invalid = writeEnv('off', { ALERT_EMAIL_TO: 'not-an-email' })
    try {
      const missingResult = runPreflight(missing.file, 'production')
      expect(missingResult.status).toBe(1)
      expect(missingResult.stderr + missingResult.stdout).toContain('ALERT_EMAIL_TO')

      const invalidResult = runPreflight(invalid.file, 'production')
      expect(invalidResult.status).toBe(1)
      expect(invalidResult.stderr + invalidResult.stdout).toContain('ALERT_EMAIL_TO')
    } finally {
      rmSync(missing.dir, { recursive: true, force: true })
      rmSync(invalid.dir, { recursive: true, force: true })
    }
  })

  it('keeps application and Alertmanager SMTP TLS modes aligned', () => {
    const implicitOnSubmissionPort = writeEnv('off', { SMTP_SECURE: 'true', SMTP_PORT: '587' })
    const plainOnImplicitPort = writeEnv('off', { SMTP_SECURE: 'false', SMTP_PORT: '465' })
    try {
      const implicitResult = runPreflight(implicitOnSubmissionPort.file, 'production')
      expect(implicitResult.status).toBe(1)
      expect(implicitResult.stderr + implicitResult.stdout).toContain('SMTP_PORT=465')

      const plainResult = runPreflight(plainOnImplicitPort.file, 'production')
      expect(plainResult.status).toBe(1)
      expect(plainResult.stderr + plainResult.stdout).toContain('SMTP_SECURE=true')
    } finally {
      rmSync(implicitOnSubmissionPort.dir, { recursive: true, force: true })
      rmSync(plainOnImplicitPort.dir, { recursive: true, force: true })
    }
  })

  it('rejects a production env file that claims MONEXUS_DEPLOY_ENV=staging', () => {
    const env = writeEnv('off', { MONEXUS_DEPLOY_ENV: 'staging' })
    try {
      const result = runPreflight(env.file, 'production')
      expect(result.status).toBe(1)
      expect(result.stderr + result.stdout).toContain('MONEXUS_DEPLOY_ENV')
    } finally {
      rmSync(env.dir, { recursive: true, force: true })
    }
  })

  it('rejects a staging env file that claims MONEXUS_DEPLOY_ENV=production', () => {
    const env = writeEnv('shadow', { MONEXUS_DEPLOY_ENV: 'production' })
    try {
      const result = runPreflight(env.file, 'staging')
      expect(result.status).toBe(1)
      expect(result.stderr + result.stdout).toContain('MONEXUS_DEPLOY_ENV')
    } finally {
      rmSync(env.dir, { recursive: true, force: true })
    }
  })
})

describe('staging Compose deploy-env overlay', () => {
  const ROOT = path.resolve(SERVER_ROOT, '..')

  it('wires the staging overlay in staging-compose.sh', async () => {
    const { readFile } = await import('node:fs/promises')
    const script = await readFile(path.join(ROOT, 'scripts/staging-compose.sh'), 'utf8')
    const overlay = await readFile(path.join(ROOT, 'docker-compose.staging.yml'), 'utf8')
    const prod = await readFile(path.join(ROOT, 'docker-compose.prod.yml'), 'utf8')

    expect(script).toContain('docker-compose.staging.yml')
    expect(prod).toContain('NODE_ENV: production')
    expect(prod).toMatch(/MONEXUS_DEPLOY_ENV:\s*production/)
    expect(prod).not.toContain('${MONEXUS_DEPLOY_ENV')
    expect(overlay).toMatch(/MONEXUS_DEPLOY_ENV:\s*staging/)
    expect(overlay).not.toContain('${MONEXUS_DEPLOY_ENV')
  })

  it('merges NODE_ENV=production with MONEXUS_DEPLOY_ENV=staging', () => {
    // Env file claims production on purpose: the staging overlay must win.
    const env = writeComposeEnv({
      MONEXUS_DEPLOY_ENV: 'production',
      POINT_VALUE_POLICY_MODE: 'shadow',
    })
    try {
      const result = runComposeConfig(env.file, [
        path.join(ROOT, 'docker-compose.prod.yml'),
        path.join(ROOT, 'docker-compose.vps.yml'),
        path.join(ROOT, 'docker-compose.staging.yml'),
      ])
      expect(result.status, result.stderr + result.stdout).toBe(0)
      expect(result.stdout).toMatch(/NODE_ENV:\s*production/)
      expect(result.stdout).toMatch(/MONEXUS_DEPLOY_ENV:\s*staging/)
      expect(result.stdout).not.toMatch(/NODE_ENV:\s*development/)
      expect(result.stdout).toMatch(/POINT_VALUE_POLICY_MODE:\s*shadow/)
    } finally {
      rmSync(env.dir, { recursive: true, force: true })
    }
  })

  it('keeps production Compose deploy env production even if the env file claims staging', () => {
    const env = writeComposeEnv({
      MONEXUS_DEPLOY_ENV: 'staging',
      POINT_VALUE_POLICY_MODE: 'off',
    })
    try {
      const result = runComposeConfig(env.file, [
        path.join(ROOT, 'docker-compose.prod.yml'),
      ])
      expect(result.status, result.stderr + result.stdout).toBe(0)
      expect(result.stdout).toMatch(/NODE_ENV:\s*production/)
      expect(result.stdout).toMatch(/MONEXUS_DEPLOY_ENV:\s*production/)
      expect(result.stdout).not.toMatch(/MONEXUS_DEPLOY_ENV:\s*staging/)
      expect(result.stdout).not.toMatch(/NODE_ENV:\s*development/)
    } finally {
      rmSync(env.dir, { recursive: true, force: true })
    }
  })
})

function composeSpawnEnv(envFile: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const idx = line.indexOf('=')
    if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return env
}

function runComposeConfig(envFile: string, composeFiles: string[]) {
  return spawnSync(
    'docker',
    [
      'compose',
      '--project-name', 'monexus-vp-config',
      '--env-file', envFile,
      ...composeFiles.flatMap(file => ['-f', file]),
      'config',
    ],
    {
      cwd: path.resolve(SERVER_ROOT, '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: composeSpawnEnv(envFile),
    },
  )
}

function writeComposeEnv(extras: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'monexus-vp-compose-'))
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
    TURNSTILE_SECRET_KEY: 'turnstile-secret-for-compose',
    TURNSTILE_ALLOWED_HOSTNAMES: 'staging.example.com',
    FRONTEND_ORIGIN: 'https://staging.example.com',
    STORAGE_ENDPOINT: 'https://minio.example.com',
    STORAGE_BUCKET: 'monexus-uploads',
    STORAGE_ACCESS_KEY: 'ak',
    STORAGE_SECRET_KEY: 'sk',
    DELIVERY_STORAGE_BUCKET: 'monexus-files',
    DELIVERY_STORAGE_PUBLIC_ENDPOINT: 'https://files.example.com',
    WEBHOOK_SECRET_ENC_KEY: 'a'.repeat(64),
    REDIS_PASSWORD: 'redis-password-for-compose',
    POINT_VALUE_POLICY_MODE: 'shadow',
    ...extras,
  }
  writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'))
  return { dir, file }
}
