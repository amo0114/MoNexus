import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.CI
    ? undefined
    : [
        {
          command: 'npm run dev --prefix server',
          url: 'http://localhost:3000/api/health',
          timeout: 60_000,
          reuseExistingServer: true,
        },
        {
          command: 'npm run dev',
          url: 'http://localhost:5173',
          timeout: 60_000,
          reuseExistingServer: true,
        },
      ],
})
