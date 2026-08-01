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

const adminProfile = {
  ...profile,
  id: 1,
  email: 'admin-abuse-ui@test.local',
  role: 'admin',
  emailVerified: '2026-08-01T00:00:00.000Z',
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

test('admin abuse panel renders masked records and requires a ticketed confirmation before voiding a reward', async ({ page }) => {
  let voidRequest: Record<string, unknown> | null = null

  await page.setViewportSize({ width: 375, height: 800 })

  await page.addInitScript((authenticatedProfile) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: {
        user: authenticatedProfile,
        // `fetchMeWithRoleHealing` decodes the role before deciding whether
        // to refresh. A minimally shaped, non-secret test JWT keeps this
        // browser-only mock on the intended MFA-admin path.
        accessToken: 'e30.eyJyb2xlIjoiYWRtaW4ifQ.signature',
        isLoggedIn: true,
      },
      version: 0,
    }))
  }, adminProfile)
  await mockRegistry(page)
  await page.route(apiRoute('/auth/me'), route => route.fulfill({ json: adminProfile }))
  // Keep the browser fixture independent of a real refresh cookie. The
  // production API itself has separate MFA coverage; this test asserts the
  // panel's masked rendering and confirmation contract.
  await page.route(apiRoute('/auth/refresh'), route => route.fulfill({
    json: { accessToken: 'e30.eyJyb2xlIjoiYWRtaW4ifQ.signature' },
  }))
  await page.route(apiRoute('/admin/stats'), route => route.fulfill({ json: { users: 0, orders: 0, totalPoints: 0 } }))
  await page.route(apiRoute('/admin/abuse/overview'), route => route.fulfill({
    json: {
      window: '24h',
      since: '2026-08-01T00:00:00.000Z',
      registrations: { attempts: 3, accepted: 2, rejected: 1 },
      challengeFailures: 1,
      verificationEmail: { sent: 1, throttled: 0 },
      unverifiedUsers: 1,
      referrals: { pendingVerification: 1, qualified: 0, quotaExhausted: 0, voided: 0 },
      rewards: { pendingVerification: 1, held: 1, granted: 0, voided: 0 },
    },
  }))
  await page.route(apiRoute('/admin/abuse/referrals'), route => route.fulfill({
    json: {
      total: 1,
      page: 1,
      pageSize: 20,
      items: [{
        id: 8,
        status: 'pending_verification',
        qualifiedAt: null,
        voidedAt: null,
        qualificationDay: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        inviter: { id: 4, email: 'i***@example.test', referralSuspended: false },
        invitee: { id: 7, email: 'n***@example.test', emailVerified: null },
        reward: {
          id: 9,
          amount: 15,
          state: 'pending_verification',
          availableAt: null,
          grantedAt: null,
          voidedAt: null,
          voidReason: null,
        },
      }],
    },
  }))
  await page.route(apiRoute('/admin/abuse/rewards'), route => route.fulfill({
    json: {
      total: 1,
      page: 1,
      pageSize: 20,
      items: [{
        id: 9,
        kind: 'referral',
        amount: 15,
        state: 'held',
        availableAt: '2026-08-08T00:00:00.000Z',
        grantedAt: null,
        voidedAt: null,
        voidReason: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        recipient: { id: 4, email: 'i***@example.test' },
        inviteRelation: {
          id: 8,
          status: 'pending_verification',
          inviter: { id: 4, email: 'i***@example.test', referralSuspended: false },
          invitee: { id: 7, email: 'n***@example.test' },
        },
      }],
    },
  }))
  await page.route(apiRoute('/admin/abuse/rewards/9/void'), async route => {
    voidRequest = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
    await route.fulfill({ json: { id: 9, kind: 'referral', amount: 15, state: 'voided', caseRef: 'RAP-123' } })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: '注册与激励风控' }).click()

  await expect(page.getByRole('heading', { name: '注册与激励风控' })).toBeVisible()
  await expect(page.getByText('i***@example.test').first()).toBeVisible()
  await expect(page.getByText('奖励 held')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('button', { name: '作废奖励' }).click()
  const dialog = page.getByTestId('admin-abuse-confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认执行' })).toBeDisabled()
  await dialog.getByLabel('工单编号').fill('rap-123')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认执行' }).click()

  await expect.poll(() => voidRequest).toEqual({ caseRef: 'RAP-123' })
  await expect(page.getByText('已作废未发放奖励')).toBeVisible()
})
