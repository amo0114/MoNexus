import { defineConfig, devices } from '@playwright/test'

/**
 * SPEC-NOTIFY-RT-001 — dedicated Playwright config for the realtime suites.
 *
 * Isolation contract (implement.md 3.2/3.3):
 *  - Backend A on 127.0.0.1:3112 (realtime=true), frontend on 127.0.0.1:5182.
 *  - Vite proxy -> 3112 via VITE_API_PROXY_TARGET.
 *  - reuseExistingServer=false; workers=1.
 *  - trace, screenshot, and video artifacts are disabled because tests carry
 *    bearer credentials, login passwords, and delivery secrets. Evidence is
 *    limited to redacted list reporter/stdout output.
 * The DB is a dedicated `monexus_test_notification_realtime` prepared by
 * scripts/verify-notification-realtime-e2e.sh (git-ignored local env).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['notification-realtime-client.spec.ts', 'notification-realtime.spec.ts'],
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5182',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx src/main.ts',
      cwd: './server',
      url: 'http://127.0.0.1:3112/api/health/ready',
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        PORT: '3112',
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
        JWT_SECRET: 'test-secret-key-at-least-32-characters-long!!',
        FRONTEND_ORIGIN: 'http://localhost:5182',
        COOKIE_SECURE: 'false',
        API_RATE_LIMIT_MAX: '3000',
        NOTIFICATION_ENABLED: 'true',
        NOTIFICATION_REALTIME_ENABLED: 'true',
      },
    },
    {
      command: 'npm run dev -- --port 5182 --strictPort',
      url: 'http://localhost:5182',
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        VITE_API_PROXY_TARGET: 'http://127.0.0.1:3112',
      },
    },
  ],
})
