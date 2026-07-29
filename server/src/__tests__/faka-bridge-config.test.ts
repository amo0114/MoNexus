import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const VALID_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
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
}

function loadConfigWith(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [key, value] of Object.entries({ ...PROD_BASE_ENV, ...overrides })) {
    if (value !== undefined) env[key] = value
  }
  return spawnSync(
    'npx',
    [
      'tsx',
      '-e',
      "import('./src/config/index.js').then(m => { console.log('CONFIG_OK'); console.log('FAKA=' + m.config.fakaBridge.enabled); process.exit(0) })",
    ],
    { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 }
  )
}

describe('FakaBridge production config guards', () => {
  it('boots without FakaBridge env (feature off)', () => {
    const result = loadConfigWith({})
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('CONFIG_OK')
    expect(result.stdout).toContain('FAKA=false')
  })

  it('boots with both URL and SECRET set', () => {
    const result = loadConfigWith({
      FAKA_BRIDGE_URL: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      FAKA_BRIDGE_SECRET: 'd035ba30fe53ccae0e4ffaf6aa96227e5e88589909de448b383ff61d525b4ec9',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('FAKA=true')
  })

  it('refuses partial config (URL without SECRET)', () => {
    const result = loadConfigWith({
      FAKA_BRIDGE_URL: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      FAKA_BRIDGE_SECRET: undefined,
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('FAKA_BRIDGE_URL and FAKA_BRIDGE_SECRET')
  })

  it('refuses partial config (SECRET without URL)', () => {
    const result = loadConfigWith({
      FAKA_BRIDGE_URL: undefined,
      FAKA_BRIDGE_SECRET: 'only-secret-no-url-here-32chars-min!!',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('FAKA_BRIDGE_URL and FAKA_BRIDGE_SECRET')
  })

  it('refuses FAKA_BRIDGE_ALLOW_INSECURE_TARGETS in production', () => {
    const result = loadConfigWith({
      FAKA_BRIDGE_URL: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      FAKA_BRIDGE_SECRET: 'd035ba30fe53ccae0e4ffaf6aa96227e5e88589909de448b383ff61d525b4ec9',
      FAKA_BRIDGE_ALLOW_INSECURE_TARGETS: 'true',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('FAKA_BRIDGE_ALLOW_INSECURE_TARGETS')
  })

  it('refuses http FAKA_BRIDGE_URL in production', () => {
    const result = loadConfigWith({
      FAKA_BRIDGE_URL: 'http://v.uuwu.de/plugin/faka-bridge/order-paid',
      FAKA_BRIDGE_SECRET: 'd035ba30fe53ccae0e4ffaf6aa96227e5e88589909de448b383ff61d525b4ec9',
    })
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain('https')
  })
})
