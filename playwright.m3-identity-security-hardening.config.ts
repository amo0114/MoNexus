import { defineConfig, devices } from '@playwright/test'

const isolatedDatabaseName = 'monexus_m3_ish_test'

function isolatedDatabaseUrl() {
  const databaseUrl = process.env.M3_ISH_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('M3_ISH_DATABASE_URL is required for the isolated M3-ISH Playwright suite')
  }

  try {
    if (new URL(databaseUrl).pathname !== `/${isolatedDatabaseName}`) throw new Error('wrong database')
    return databaseUrl
  } catch {
    throw new Error('M3-ISH Playwright requires the isolated monexus_m3_ish_test database')
  }
}

const databaseUrl = isolatedDatabaseUrl()

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'm3-identity-security-hardening.spec.ts',
    'm3-identity-security-hardening.real.spec.ts',
  ],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npm run dev --prefix server',
      url: 'http://127.0.0.1:3103/api/health',
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '3103',
        DATABASE_URL: databaseUrl,
        FRONTEND_ORIGIN: 'http://127.0.0.1:5178',
        COOKIE_SECURE: 'false',
        API_RATE_LIMIT_MAX: '3000',
        JWT_SECRET: 'm3-ish-e2e-jwt-secret-at-least-32-characters',
        MFA_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
      },
    },
    {
      command: 'npm run dev -- --port 5178 --strictPort',
      url: 'http://127.0.0.1:5178',
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: 'http://127.0.0.1:3103',
      },
    },
  ],
})
