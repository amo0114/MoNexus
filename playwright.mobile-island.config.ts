import { defineConfig } from '@playwright/test'

/** UI-only lane: owns a frontend, all APIs mocked, no backend or database. */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['mobile-chrome.spec.ts', 'mobile-island-merchant-final.spec.ts', 'mobile-island-quality.spec.ts'],
  outputDir: 'test-results/mobile-island',
  workers: 1,
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5192',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5192 --strictPort',
    url: 'http://127.0.0.1:5192',
    timeout: 60_000,
    reuseExistingServer: false,
    env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:1' },
  },
})
