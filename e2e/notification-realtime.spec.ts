import { execSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

/**
 * SPEC-NOTIFY-RT-001 (T-QA-003) — core no-refresh browser E2E (AC-RT-001).
 *
 * A fresh merchant with a manual-service product and a funded buyer are seeded
 * on the dedicated DB. The merchant is logged in (localStorage session), opens
 * the dashboard, and a buyer creates a manual order through the real HTTP API.
 * The merchant UI must show the new unread notification WITHOUT page.reload /
 * manual polling (NRT-024).
 */
let fixture: {
  merchantUserId: number
  merchantToken: string
  buyerToken: string
  productId: number
  offerId: number
}

test.beforeAll(async () => {
  const out = execSync(
    'cd server && node --import tsx scripts/notification-realtime-e2e-seed.mjs',
    { encoding: 'utf8', env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      JWT_SECRET: 'test-secret-key-at-least-32-characters-long!!',
      FRONTEND_ORIGIN: 'http://localhost:5182',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    } }
  )
  fixture = JSON.parse(out.trim())
})

test('merchant sees a buyer-created manual order without refresh (AC-RT-001)', async ({ page }) => {
  // Inject the merchant session exactly as authStore persists it.
  await page.addInitScript(
    ({ merchantToken, merchantUserId }) => {
      const persisted = {
        state: {
          user: {
            id: merchantUserId,
            role: 'merchant',
            email: 'rt-e2e@test.local',
            nickname: '实时E2E商家',
            points: 0,
          },
          isLoggedIn: true,
          accessToken: merchantToken,
        },
        version: 0,
      }
      window.localStorage.setItem('monexus-auth', JSON.stringify(persisted))
    },
    { merchantToken: fixture.merchantToken, merchantUserId: fixture.merchantUserId }
  )

  await page.goto('/merchant/dashboard')
  // The dashboard shell renders (RoleGuard + merchant active).
  await expect(page).toHaveURL(/\/merchant\/dashboard/)
  await page.waitForLoadState('domcontentloaded')

  // Buyer creates a manual order through the real HTTP API (port 3112).
  const orderRes = await page.request.post('http://127.0.0.1:3112/api/orders', {
    data: { productId: fixture.productId, offerId: fixture.offerId, expectedPrice: 100 },
    headers: { Authorization: `Bearer ${fixture.buyerToken}` },
  })
  expect([201, 200]).toContain(orderRes.status())

  // The merchant bell badge must appear (unread > 0) WITHOUT any reload.
  const badge = page.locator('[data-testid="notification-bell-total-count"]')
  await expect(badge).toHaveText(/[1-9]/, { timeout: 10_000 })
  expect(Number((await badge.innerText()).trim())).toBeGreaterThan(0)
})
