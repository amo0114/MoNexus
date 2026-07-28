import { defineConfig, devices } from '@playwright/test'

const databaseUrl = process.env.M3_ISH_DATABASE_URL

if (!databaseUrl) {
  throw new Error('M3_ISH_DATABASE_URL is required for the isolated M3-ISH Playwright suite')
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'm3-identity-security-hardening.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
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
