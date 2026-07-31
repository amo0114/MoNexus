import { expect, test, type Page } from '@playwright/test'

const profile = {
  id: 991,
  email: 'registration-ui@test.local',
  nickname: null,
  role: 'user',
  status: '正常',
  inviteCode: 'RAP991',
  points: 0,
  emailVerified: null,
  merchant: null,
}

const registry = {
  productTypes: [],
  deliveryModes: [],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 10, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
  memberTiers: [],
  memberTierThresholds: { silver: 1_000, gold: 5_000, platinum: 10_000 },
  memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
}

function apiRoute(path: string) {
  const expectedPathname = `/api${path}`
  return (url: URL) => url.pathname === expectedPathname
}

async function mockRegistry(page: Page) {
  await page.route(apiRoute('/config/registry'), route => route.fulfill({ json: registry }))
}

test('uses a one-time in-memory Turnstile proof only after registration submission', async ({ page }) => {
  const proof = 'turnstile-proof-must-not-persist'
  let registerPayload: Record<string, unknown> | null = null

  await page.addInitScript(() => {
    let options: { callback: (token: string) => void } | null = null
    ;(window as unknown as { turnstile: unknown }).turnstile = {
      render: (_container: HTMLElement, nextOptions: { callback: (token: string) => void }) => {
        options = nextOptions
        return 'fake-turnstile-widget'
      },
      execute: () => options?.callback('turnstile-proof-must-not-persist'),
      reset: () => undefined,
      remove: () => undefined,
    }
  })
  await mockRegistry(page)
  await page.route(apiRoute('/auth/registration-status'), route => route.fulfill({
    json: {
      registrationEnabled: true,
      registrationAvailable: true,
      challenge: { provider: 'turnstile', siteKey: 'public-test-site-key' },
    },
  }))
  await page.route(apiRoute('/auth/register'), async route => {
    registerPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
    await route.fulfill({ json: { user: profile, accessToken: 'registration-ui-access-token' } })
  })
  await page.route(apiRoute('/auth/me'), route => route.fulfill({ json: profile }))

  await page.goto('/login')
  await page.getByRole('button', { name: '没有账号？注册新账号' }).click()
  await page.getByLabel('邮箱地址').fill(profile.email)
  await page.getByLabel('密码（至少 6 位）').fill('TestPass123!')
  await page.getByRole('button', { name: '注册账号' }).click()

  await expect(page).toHaveURL(/\/$/)
  expect(registerPayload).toMatchObject({
    email: profile.email,
    password: 'TestPass123!',
    turnstileToken: proof,
  })
  const stored = await page.evaluate(() => localStorage.getItem('monexus-auth') ?? '')
  expect(stored).not.toContain(proof)
})

test('keeps registration disabled distinct from a temporary unavailable state', async ({ page }) => {
  let status = {
    registrationEnabled: false,
    registrationAvailable: false,
    challenge: null,
  }

  await mockRegistry(page)
  await page.route(apiRoute('/auth/registration-status'), route => route.fulfill({ json: status }))

  await page.goto('/login')
  await expect(page.getByText('当前已暂停新用户注册')).toBeVisible()
  await expect(page.getByRole('button', { name: '没有账号？注册新账号' })).toHaveCount(0)

  status = {
    registrationEnabled: true,
    registrationAvailable: false,
    challenge: null,
  }
  await page.reload()
  await expect(page.getByText('注册服务暂不可用，请稍后重试')).toBeVisible()
  await expect(page.getByText('当前已暂停新用户注册')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '没有账号？注册新账号' })).toHaveCount(0)
})

test('strips a fragment token and claims it once through the authenticated POST', async ({ page }) => {
  const verificationToken = 'fragment-token-must-not-persist'
  let verifyRequests = 0

  await page.addInitScript((authenticatedProfile) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: {
        user: authenticatedProfile,
        accessToken: 'verification-ui-access-token',
        isLoggedIn: true,
      },
      version: 0,
    }))
  }, profile)
  await mockRegistry(page)
  await page.route(apiRoute('/auth/verify-email'), async route => {
    verifyRequests += 1
    expect(route.request().method()).toBe('POST')
    expect(JSON.parse(route.request().postData() ?? '{}')).toEqual({ token: verificationToken })
    await route.fulfill({ json: { ok: true } })
  })
  await page.route(apiRoute('/auth/me'), route => route.fulfill({
    json: { ...profile, emailVerified: '2026-08-01T00:00:00.000Z' },
  }))

  await page.goto(`/verify-email#token=${verificationToken}`)
  await expect(page.getByText('邮箱已验证')).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(verificationToken))
  expect(verifyRequests).toBe(1)

  const stored = await page.evaluate(() => localStorage.getItem('monexus-auth') ?? '')
  expect(stored).not.toContain(verificationToken)
})

test('does not claim a fragment token without an authenticated session', async ({ page }) => {
  let verifyRequests = 0

  await mockRegistry(page)
  await page.route(apiRoute('/auth/verify-email'), route => {
    verifyRequests += 1
    return route.fulfill({ json: { ok: true } })
  })

  await page.goto('/verify-email#token=anonymous-token-must-not-be-claimed')
  await expect(page.getByText('请先登录')).toBeVisible()
  await expect(page).not.toHaveURL(/anonymous-token-must-not-be-claimed/)
  expect(verifyRequests).toBe(0)
})
