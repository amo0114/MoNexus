import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // The real MFA suite owns an isolated database/ports and is executed only by
  // playwright.m3-identity-security-hardening.config.ts. Default CI must not
  // import its fixture while using the shared monexus_test database.
  testIgnore: ['**/m3-identity-security-hardening.real.spec.ts'],
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
          // 全量 e2e 共享一个 IP，整轮 /api 请求量已超默认 300/15min，
          // 提高 e2e 栈的限流上限避免套件尾部随机 429。认证模块也在
          // NODE_ENV=test 下跳过密码猜测限流；E2E 使用的是固定 seed 账号，
          // 不应被整套测试累计的登录次数误伤。
          env: { NODE_ENV: 'test', API_RATE_LIMIT_MAX: '3000' },
        },
        {
          command: 'npm run dev',
          url: 'http://localhost:5173',
          timeout: 60_000,
          reuseExistingServer: true,
        },
      ],
})
