import { defineConfig, devices } from '@playwright/test'

/**
 * SPEC-CATALOG-OPS / PAR-CMI-001 — Catalog Operations browser E2E stack
 * (Cross-spec Integration lane `feat/catalog-merch-integration`).
 *
 * Fixed loopback topology (never the default ports, never a shared server):
 *   - API            http://127.0.0.1:3105
 *   - Web (Vite)     http://127.0.0.1:5180
 *   - Xboard fixture http://127.0.0.1:3106  (started by the verify runner)
 *
 * Load-time strictness (this file fails before any server starts):
 *   - CATALOG_OPS_DATABASE_URL is required and must resolve to the frozen
 *     disposable DB `monexus_test_catalog_merch_integration` (postgres:// or
 *     postgresql:// protocol, exact pathname). Any other database or an
 *     unparseable URL is rejected. Errors never echo the URL or its
 *     credentials, and there is deliberately NO hardcoded credential fallback.
 *   - E2E_ADMIN_MFA_TOTP_SECRET is required and must be exactly 32 RFC 4648
 *     Base32 characters (A-Z, 2-7). Errors never echo the factor.
 *
 * The config itself never creates/drops/migrates/seeds the database — the
 * verify runner owns the DB lifecycle (scripts/cmi/dbguard.sh).
 */

const API_PORT = 3105
const WEB_PORT = 5180
const XBOARD_FIXTURE_PORT = 3106

const API_ORIGIN = `http://127.0.0.1:${API_PORT}`
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
const XBOARD_ORIGIN = `http://127.0.0.1:${XBOARD_FIXTURE_PORT}`

const EXPECTED_DATABASE_PATH = '/monexus_test_catalog_merch_integration'

// e2e/helpers.ts reads process.env.E2E_API_URL at module load; this config is
// evaluated before any spec module, so pin it to this suite's API origin.
process.env.E2E_API_URL = API_ORIGIN

function validatedDatabaseUrl(): string {
  const raw = process.env.CATALOG_OPS_DATABASE_URL
  if (!raw) {
    throw new Error(
      'CATALOG_OPS_DATABASE_URL is required: it must point at the disposable monexus_test_catalog_merch_integration database'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(
      'CATALOG_OPS_DATABASE_URL is not a parseable database URL; refusing to guess a database'
    )
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('CATALOG_OPS_DATABASE_URL must be a PostgreSQL connection string')
  }
  if (parsed.pathname !== EXPECTED_DATABASE_PATH) {
    throw new Error(
      'CATALOG_OPS_DATABASE_URL must point at the disposable monexus_test_catalog_merch_integration database'
    )
  }
  return raw
}

const TEST_TOTP_FACTOR_PATTERN = /^[A-Z2-7]{32}$/

function validatedMfaFactor(): string {
  const factor = process.env.E2E_ADMIN_MFA_TOTP_SECRET
  if (!factor || !TEST_TOTP_FACTOR_PATTERN.test(factor)) {
    throw new Error(
      'E2E_ADMIN_MFA_TOTP_SECRET must be exactly 32 RFC 4648 Base32 characters (A-Z, 2-7); refusing to guess a factor'
    )
  }
  return factor
}

const databaseUrl = validatedDatabaseUrl()
const mfaFactor = validatedMfaFactor()

/**
 * Storage must stay on the test in-memory adapter. The frozen server config
 * (server/src/config/index.ts) validates the URL / min(1) STORAGE_* and
 * DELIVERY_STORAGE_* fields with zod and REJECTS empty strings at boot, so an
 * empty-string override would break the API webServer. Instead we explicitly
 * delete the keys from the spread process.env — guaranteeing no outer
 * production storage env can leak into the test server. Every remaining env
 * value is a string.
 */
const STORAGE_ENV_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'STORAGE_PUBLIC_URL_BASE',
  'STORAGE_REGION',
  'DELIVERY_STORAGE_BUCKET',
  'DELIVERY_STORAGE_PUBLIC_ENDPOINT',
] as const

function apiWebServerEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env }
  for (const key of STORAGE_ENV_KEYS) delete env[key]
  return Object.assign(env, {
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    DATABASE_URL: databaseUrl,
    FRONTEND_ORIGIN: WEB_ORIGIN,
    COOKIE_SECURE: 'false',
    API_RATE_LIMIT_MAX: '3000',
    // Test-only static JWT signing secret (>= 32 chars), never a real secret.
    JWT_SECRET: 'catalog-ops-e2e-jwt-secret-at-least-32-characters',
    // Existing test static canonical base64 (32 bytes of 0x07); the same value
    // the legal-pages / m3-ISH suites use to encrypt the seed admin TOTP.
    MFA_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    E2E_ADMIN_MFA_TOTP_SECRET: mfaFactor,
    REDIS_ENABLED: 'false',
    REDIS_REQUIRED: 'false',
    NOTIFICATION_ENABLED: 'false',
    NOTIFICATION_EMAIL_ENABLED: 'false',
    // Xboard provider is a local loopback fixture only — never a real provider.
    FAKA_BRIDGE_URL: `${XBOARD_ORIGIN}/order-paid`,
    FAKA_BRIDGE_STATUS_URL: `${XBOARD_ORIGIN}/order-status`,
    FAKA_BRIDGE_REVOKE_URL: `${XBOARD_ORIGIN}/order-revoke`,
    FAKA_BRIDGE_SECRET: 'catalog-ops-e2e-faka-bridge-secret-0123456789abcdef',
    FAKA_BRIDGE_ALLOW_INSECURE_TARGETS: 'true',
    STORAGE_UI_CONFIG_ENABLED: 'false',
  })
}

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'catalog-product-lifecycle.spec.ts',
    'catalog-category-governance.spec.ts',
    'catalog-xboard-import.spec.ts',
  ],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npm run dev --prefix server',
      url: `${API_ORIGIN}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: apiWebServerEnv(),
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_ORIGIN,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: API_ORIGIN,
      },
    },
  ],
})
