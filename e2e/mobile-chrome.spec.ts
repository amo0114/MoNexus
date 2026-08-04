import { expect, test } from '@playwright/test'

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
})

const TEST_USER = {
  id: 9_901,
  email: 'mobile-chrome@example.test',
  nickname: '移动端测试',
  role: 'user' as const,
  status: 'active',
  points: 1_280,
  emailVerified: '2026-01-01T00:00:00.000Z',
  merchant: null,
}

const TEST_ADMIN = {
  ...TEST_USER,
  id: 9_902,
  email: 'mobile-admin-chrome@example.test',
  nickname: '移动端管理员',
  role: 'admin' as const,
}

test('mobile chrome morphs into an island and keeps banners attached', async ({ page }) => {
  // This is a chrome test, not an authentication/API test. Keep it isolated
  // from the shared local API rate limiter while exercising the real Profile
  // actions that call showToast.
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url())
    // The Vite source tree also contains /src/api/*.ts modules. Let those
    // through; only browser requests to the backend API are mocked here.
    if (!pathname.startsWith('/api/')) return route.fallback()
    const method = route.request().method()

    if (pathname === '/api/auth/me') return route.fulfill({ json: TEST_USER })
    if (pathname === '/api/announcements') return route.fulfill({ json: [] })
    if (pathname === '/api/orders') return route.fulfill({ json: [] })
    if (pathname === '/api/points/checkin/status') return route.fulfill({ json: { hasCheckedIn: false } })
    if (pathname === '/api/points/checkin' && method === 'POST') {
      return route.fulfill({ json: { balanceAfter: 1330, totalReward: 50 } })
    }
    if (pathname === '/api/points/tier') {
      return route.fulfill({
        json: {
          tier: 'bronze', label: '青铜', tone: 'neutral', lifetimeEarnedPoints: 0, bonusBps: 0,
          thresholds: { silver: 100, gold: 500, platinum: 1_000 }, nextTier: 'silver', pointsToNextTier: 100,
        },
      })
    }
    if (pathname === '/api/config/registry') {
      return route.fulfill({
        json: {
          productTypes: [], deliveryModes: [], orderStatuses: [], settlementStatuses: [],
          pagination: { defaultPageSize: 20, maxPageSize: 100 }, inventory: { lowStockThreshold: 5 },
          memberTiers: [], memberTierThresholds: { silver: 100, gold: 500, platinum: 1_000 },
          memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
        },
      })
    }
    if (pathname === '/api/invites/me') {
      return route.fulfill({ json: { eligible: false, reason: 'not_verified', quota: null, codes: [] } })
    }
    if (pathname === '/api/auth/sessions') return route.fulfill({ json: { items: [] } })

    return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } })
  })

  await page.addInitScript((user) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: { user, accessToken: 'mobile-chrome-test-token', isLoggedIn: true },
      version: 0,
    }))
  }, TEST_USER)
  await page.goto('/profile')

  const navbar = page.getByTestId('app-navbar')
  const shell = page.getByTestId('navbar-shell')
  await expect(navbar).toBeVisible()

  // The compact transition must stay off the mobile backdrop-filter path and
  // narrow only the shell. A broad `transition: all` plus a blur over a
  // scrolling surface was the source of the production frame drops.
  const mobileChrome = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="app-navbar"]')
    const navbarShell = document.querySelector<HTMLElement>('[data-testid="navbar-shell"]')
    if (!nav || !navbarShell) return null
    return {
      navBackdrop: getComputedStyle(nav).backdropFilter,
      shellBackdrop: getComputedStyle(navbarShell).backdropFilter,
      shellTransition: getComputedStyle(navbarShell).transitionProperty,
    }
  })
  expect(mobileChrome).not.toBeNull()
  expect(mobileChrome!.navBackdrop).toBe('none')
  expect(mobileChrome!.shellBackdrop).toBe('none')
  expect(mobileChrome!.shellTransition).toContain('max-width')
  expect(mobileChrome!.shellTransition).not.toBe('all')

  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })

  // Ensure the page can scroll even when the local fixture has few products.
  await page.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '1000px'
    spacer.dataset.testSpacer = 'mobile-chrome'
    document.body.append(spacer)
    window.scrollTo(0, 100)
  })
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(48)
  await page.waitForTimeout(400)

  const compactShell = await shell.boundingBox()
  expect(compactShell).not.toBeNull()
  // A 390px viewport should not leave a near-full-width rounded header.
  expect(compactShell!.width).toBeLessThan(350)
  // 18.5rem is also the complete 320px viewport content width. Keep every
  // existing 40px mobile target inside it rather than trading jank for an
  // overflowed island on the narrowest supported phones.
  expect(await shell.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  // A real quiet success action is absorbed by the island, not rendered as a
  // second top banner. The request is mocked solely to keep the E2E fixture
  // independent from the shared local check-in state.
  await page.getByRole('button', { name: '每日打卡' }).click()
  await expect(shell.getByText('打卡成功！积分 +50', { exact: true })).toBeVisible()
  await expect(page.locator('[data-toast-card]')).toHaveCount(0)

  // A regular error preempts the island and uses the same measured navbar
  // edge, rather than the former hard-coded 77px offset. This validation is
  // local and does not need a network request.
  await page.getByTestId('nickname-edit').scrollIntoViewIfNeeded()
  await page.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('')
  await page.getByTestId('nickname-save').click()

  const toast = page.locator('[data-toast-card]')
  await expect(toast).toContainText('昵称需为 1-20 个字符')
  await expect(shell.getByText('打卡成功！积分 +50', { exact: true })).toHaveCount(0)

  // The CSS custom property is the layout contract used by the fallback
  // banner; wait for the border-box measurement rather than a fixed delay.
  await expect.poll(() => page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="app-navbar"]')
    const currentHeight = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--navbar-current-h'),
    )
    return nav ? Math.abs(nav.getBoundingClientRect().height - currentHeight) : Number.POSITIVE_INFINITY
  })).toBeLessThanOrEqual(1)

  const [navbarBox, toastBox] = await Promise.all([navbar.boundingBox(), toast.boundingBox()])
  expect(navbarBox).not.toBeNull()
  expect(toastBox).not.toBeNull()
  const gap = toastBox!.y - (navbarBox!.y + navbarBox!.height)
  expect(gap).toBeGreaterThanOrEqual(4)
  expect(gap).toBeLessThan(24)
})

test('mobile admin has a direct leaderboard tab', async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.fallback()

    if (pathname === '/api/auth/me') return route.fulfill({ json: TEST_ADMIN })
    if (pathname === '/api/announcements') return route.fulfill({ json: [] })
    if (pathname === '/api/config/registry') {
      return route.fulfill({
        json: {
          productTypes: [], deliveryModes: [], orderStatuses: [], settlementStatuses: [],
          pagination: { defaultPageSize: 20, maxPageSize: 100 }, inventory: { lowStockThreshold: 5 },
          memberTiers: [], memberTierThresholds: { silver: 100, gold: 500, platinum: 1_000 },
          memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
        },
      })
    }
    if (pathname === '/api/leaderboard') {
      return route.fulfill({
        json: {
          scope: 'total', periodKey: 'ALL', periodLabel: '全部', dataThrough: null,
          updatedAt: null, top: [], me: null,
        },
      })
    }
    return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } })
  })

  await page.addInitScript((user) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: { user, accessToken: 'mobile-admin-chrome-test-token', isLoggedIn: true },
      version: 0,
    }))
  }, TEST_ADMIN)
  await page.goto('/leaderboard')

  const tab = page.getByTestId('tab-bar-leaderboard')
  await expect(tab).toBeVisible()
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('bottom-tab-bar').getByRole('button')).toHaveCount(4)
})
