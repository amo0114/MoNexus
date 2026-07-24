import { expect, test, type Page } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

const staleAccessToken = 'intentionally-expired-access-token'

async function makeAccessTokenStaleOnNextLoad(page: Page) {
  await page.addInitScript((staleToken) => {
    const raw = window.localStorage.getItem('monexus-auth')
    if (!raw) return
    const persisted = JSON.parse(raw)
    persisted.state.accessToken = staleToken
    window.localStorage.setItem('monexus-auth', JSON.stringify(persisted))
  }, staleAccessToken)
}

async function expectSessionRecovered(page: Page) {
  await expect
    .poll(() => page.evaluate((expectedStaleToken) => {
      const raw = window.localStorage.getItem('monexus-auth')
      if (!raw) return false
      const persisted = JSON.parse(raw)
      return persisted.state?.isLoggedIn === true
        && typeof persisted.state?.accessToken === 'string'
        && persisted.state.accessToken !== expectedStaleToken
    }, staleAccessToken))
    .toBe(true)
  await expect(page).not.toHaveURL(/\/login$/)
}

test.describe('auth session recovery', () => {
  test('parallel 401s in one page consume the refresh cookie once', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await makeAccessTokenStaleOnNextLoad(page)

    let refreshRequests = 0
    await page.route('**/api/auth/refresh', async (route) => {
      refreshRequests += 1
      // Let all protected page-load requests reach their 401 handlers before
      // the refresh returns. This reproduces a normal slow-network expiry.
      await new Promise(resolve => setTimeout(resolve, 150))
      await route.continue()
    })

    await page.reload()
    await expectSessionRecovered(page)
    expect(refreshRequests).toBe(1)
  })

  test('two tabs share one refresh rotation', async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL
    if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required for cross-tab auth recovery')
    const context = await browser.newContext({ baseURL })
    const firstTab = await context.newPage()
    const secondTab = await context.newPage()

    try {
      await loginAs(firstTab, SEED_ACCOUNTS.user)
      await secondTab.goto('/')
      await expect(secondTab.getByPlaceholder('搜账号、卡密、教程...')).toBeVisible()

      await Promise.all([
        makeAccessTokenStaleOnNextLoad(firstTab),
        makeAccessTokenStaleOnNextLoad(secondTab),
      ])

      let refreshRequests = 0
      await context.route('**/api/auth/refresh', async (route) => {
        refreshRequests += 1
        await new Promise(resolve => setTimeout(resolve, 150))
        await route.continue()
      })

      await Promise.all([firstTab.reload(), secondTab.reload()])
      await Promise.all([expectSessionRecovered(firstTab), expectSessionRecovered(secondTab)])
      expect(refreshRequests).toBe(1)
    } finally {
      await context.close()
    }
  })

  test('a transient refresh failure keeps the local session for retry', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await makeAccessTokenStaleOnNextLoad(page)

    let refreshRequests = 0
    await page.route('**/api/auth/refresh', async (route) => {
      refreshRequests += 1
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEMPORARY_UNAVAILABLE', message: 'temporary outage' } }),
      })
    })

    await page.reload()
    await expect.poll(() => refreshRequests).toBeGreaterThan(0)
    await expect
      .poll(() => page.evaluate(() => {
        const raw = window.localStorage.getItem('monexus-auth')
        return raw ? JSON.parse(raw).state?.isLoggedIn : false
      }))
      .toBe(true)
    await expect(page).not.toHaveURL(/\/login$/)
  })
})
