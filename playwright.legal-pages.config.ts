import { defineConfig, devices } from '@playwright/test'

/**
 * SPEC-LEGAL-001：法律页面与协议同意的独立 e2e 栈。
 *
 * 主套件保持默认（法律页面关闭，UI 零变化）；本配置以独立端口拉起
 * LEGAL_PAGES_ENABLED=true + ENFORCEMENT=enforce 的服务端，覆盖：
 * 五页直接访问/刷新、footer 分组链接、注册勾选门控、下单勾选门控、
 * 以及 enforce 模式下 API 层的 REQUIRED 契约。
 *
 * CI 使用预先 seed 的 monexus_test；法律套件结束后 workflow 会在启动
 * 默认兼容套件前重新 reset + seed。端口独立，两个套件始终串行执行。
 */

const DEFAULT_DATABASE_URL =
  'postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public'

function databaseUrl() {
  const url = process.env.LEGAL_E2E_DATABASE_URL || process.env.TEST_DATABASE_URL || DEFAULT_DATABASE_URL
  try {
    // 仅允许一次性测试库：专用 monexus_legal_test（与本套件并行互不影响）
    // 或主套件的 monexus_test（verify-local 串行场景）。
    const name = new URL(url).pathname
    if (!name.includes('monexus_legal_test') && !name.includes('monexus_test')) {
      throw new Error('wrong database')
    }
    return url
  } catch {
    throw new Error('legal-pages e2e requires a disposable monexus_legal_test / monexus_test database URL')
  }
}

const API_PORT = 3104
const WEB_PORT = 5179
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`

// helpers.ts 的 API_BASE 在模块加载时读取；config 先于 spec 加载。
process.env.E2E_API_URL = process.env.E2E_API_URL || API_ORIGIN

export default defineConfig({
  testDir: './e2e',
  testMatch: ['legal-pages.spec.ts'],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: WEB_ORIGIN,
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
      url: `${API_ORIGIN}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: databaseUrl(),
        FRONTEND_ORIGIN: WEB_ORIGIN,
        COOKIE_SECURE: 'false',
        API_RATE_LIMIT_MAX: '3000',
        JWT_SECRET: 'legal-e2e-jwt-secret-at-least-32-characters',
        MFA_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
        // 本套件的核心变量：页面开启 + 注册/下单强制协议确认。
        LEGAL_PAGES_ENABLED: 'true',
        LEGAL_PAGES_ENFORCEMENT: 'enforce',
      },
    },
    {
      // Keep the bind address aligned with WEB_ORIGIN. GitHub runners may
      // resolve Vite's default localhost bind to IPv6, while the readiness
      // probe and browser use the explicit IPv4 loopback address.
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
