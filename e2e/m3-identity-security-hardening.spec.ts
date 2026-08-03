import { expect, test, type Page } from '@playwright/test'

type MfaFixture = {
  challengeId: string
  manualKey: string
  provisioningUri: string
  recoveryCodes: string[]
}

const profile = {
  id: 701,
  email: 'm3-ui@test.local',
  nickname: null,
  role: 'admin',
  status: '正常',
  points: 500,
  merchant: null,
}

const configRegistry = {
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

const memberTier = {
  tier: 'bronze',
  label: '青铜',
  tone: 'neutral',
  lifetimeEarnedPoints: 0,
  bonusBps: 0,
  thresholds: { silver: 1_000, gold: 5_000, platinum: 10_000 },
  nextTier: 'silver',
  pointsToNextTier: 1_000,
}

// This is intentionally unsigned and only exercises the browser's role
// decoder after a mocked UI login; it is never sent to a real auth endpoint.
const uiOnlyAdminAccessToken = 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.test-signature'

// Do not use broad glob patterns such as **/api/orders** here: Vite serves
// source modules under /src/api/*, and a glob can accidentally fulfill a
// JavaScript import with mock JSON. Match only the browser API pathname.
function apiRoute(path: string) {
  const expectedPathname = `/api${path}`
  return (url: URL) => url.pathname === expectedPathname
}

function createMfaFixture(): MfaFixture {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const manualKey = `non-persistent-test-key-${nonce}`

  return {
    challengeId: `non-persistent-challenge-${nonce}`,
    manualKey,
    provisioningUri: `otpauth://totp/MoNexus:m3-ui?secret=${manualKey}`,
    recoveryCodes: Array.from({ length: 10 }, (_, index) => `not-a-real-recovery-code-${nonce}-${index}`),
  }
}

async function mockProfile(page: Page) {
  await page.route(apiRoute('/auth/me'), route => route.fulfill({ json: profile }))
}

async function mockProfileBackgroundRequests(page: Page) {
  await page.route(apiRoute('/products'), route => route.fulfill({ json: { items: [], nextCursor: null, hasMore: false } }))
  await page.route(apiRoute('/orders'), route => route.fulfill({ json: [] }))
  // ProfilePage now loads the invitation card alongside its existing
  // background data. Keep the UI-only authentication fixture self-contained
  // so its intentionally unsigned token is never sent to the real backend.
  await page.route(apiRoute('/invites/me'), route => route.fulfill({ json: {
    eligible: true,
    quota: null,
    codes: [],
  } }))
  await page.route(apiRoute('/points/history'), route => route.fulfill({ json: [] }))
  await page.route(apiRoute('/points/checkin/status'), route => route.fulfill({ json: { hasCheckedIn: false } }))
  await page.route(apiRoute('/points/tier'), route => route.fulfill({ json: memberTier }))
  await page.route(apiRoute('/config/registry'), route => route.fulfill({ json: configRegistry }))
}

async function mockAuthenticatedAppRequests(page: Page) {
  await mockProfile(page)
  await mockProfileBackgroundRequests(page)
  await page.route(apiRoute('/announcements'), route => route.fulfill({ json: [] }))
}

async function mockNormalLogin(page: Page) {
  await page.route(apiRoute('/auth/login'), route => route.fulfill({ json: { user: profile, accessToken: uiOnlyAdminAccessToken } }))
  await mockAuthenticatedAppRequests(page)
}

async function loginThroughPage(page: Page) {
  await page.goto('/login')
  await page.getByLabel('邮箱地址').fill(profile.email)
  await page.getByLabel('密码（至少 6 位）').fill('not-a-real-password')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/$/)
}

async function goToProfile(page: Page) {
  // feat/mobile-ui-polish：<md 头像入口去重到 Tab Bar「我的」（navbar 头像
  // 仅 ≥md 渲染）；按可见性选择入口，桌面行为不变。
  const tabProfile = page.getByRole('button', { name: '我的', exact: true })
  if (await tabProfile.isVisible().catch(() => false)) {
    await tabProfile.click()
  } else {
    await page.getByRole('button', { name: '个人中心' }).click()
  }
  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.getByTestId('session-manager')).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
}

test('keeps the enrollment challenge and recovery codes in memory, without refreshing or replaying MFA factor failures', async ({ page }) => {
  const fixture = createMfaFixture()
  let refreshRequests = 0
  let confirmAttempts = 0

  await page.route(apiRoute('/auth/login'), route => route.fulfill({
    status: 202,
    json: {
      status: 'mfa_enrollment_required',
      challengeId: fixture.challengeId,
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  }))
  await page.route(apiRoute('/auth/mfa/enrollment/start'), route => route.fulfill({ json: {
    provisioningUri: fixture.provisioningUri,
    manualKey: fixture.manualKey,
    expiresAt: '2030-01-01T00:00:00.000Z',
  } }))
  await page.route(apiRoute('/auth/mfa/enrollment/confirm'), route => {
    confirmAttempts += 1
    if (confirmAttempts === 1) {
      return route.fulfill({
        status: 401,
        json: { error: { code: 'MFA_VERIFICATION_FAILED', message: 'MFA 验证失败' } },
      })
    }
    return route.fulfill({
      status: 201,
      json: { user: profile, accessToken: 'm3-enrollment-access-token', recoveryCodes: fixture.recoveryCodes },
    })
  })
  await page.route(apiRoute('/auth/refresh'), route => {
    refreshRequests += 1
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'not used' } } })
  })
  await mockAuthenticatedAppRequests(page)

  await page.goto('/login')
  await page.getByLabel('邮箱地址').fill(profile.email)
  await page.getByLabel('密码（至少 6 位）').fill('not-a-real-password')
  await page.getByRole('button', { name: '登录' }).click()

  await expect(page.getByTestId('mfa-enrollment')).toBeVisible()
  await expect(page.getByTestId('mfa-enrollment-qr')).toBeVisible()
  await expect(page.getByTestId('mfa-manual-key')).toHaveText(fixture.manualKey)
  await expect(page.getByRole('navigation')).toHaveCount(0)

  const storageBeforeFactor = await page.evaluate(() => localStorage.getItem('monexus-auth') ?? '')
  expect(storageBeforeFactor).not.toContain(fixture.challengeId)
  expect(storageBeforeFactor).not.toContain(fixture.manualKey)

  await page.getByTestId('mfa-factor-code').fill('000000')
  await page.getByTestId('mfa-enrollment-confirm').click()
  await expect(page.getByText('MFA 验证失败')).toBeVisible()
  await expect(page.getByTestId('mfa-factor-code')).toHaveValue('')
  expect(refreshRequests).toBe(0)

  await page.getByTestId('mfa-factor-code').fill('111111')
  await page.getByTestId('mfa-enrollment-confirm').click()
  await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible()
  await expect(page.getByTestId('mfa-recovery-codes').getByRole('listitem')).toHaveCount(10)
  await expect(page.getByTestId('mfa-recovery-continue')).toBeDisabled()

  const storageWithRecoveryCodes = await page.evaluate(() => localStorage.getItem('monexus-auth') ?? '')
  // Completion has created a server-side session, but the UI must not persist
  // its access token until the one-time recovery-code acknowledgement.
  expect(storageWithRecoveryCodes).not.toContain('m3-enrollment-access-token')
  for (const recoveryCode of fixture.recoveryCodes) {
    expect(storageWithRecoveryCodes).not.toContain(recoveryCode)
  }

  await page.getByTestId('mfa-recovery-acknowledgement').check()
  await page.getByTestId('mfa-recovery-continue').click()
  await expect(page).toHaveURL(/\/$/)

  const storageAfterCompletion = await page.evaluate(() => localStorage.getItem('monexus-auth') ?? '')
  expect(storageAfterCompletion).not.toContain(fixture.challengeId)
  expect(storageAfterCompletion).not.toContain(fixture.manualKey)
  for (const recoveryCode of fixture.recoveryCodes) {
    expect(storageAfterCompletion).not.toContain(recoveryCode)
  }
})

test('lets an enrolled administrator switch to a recovery code without refreshing a factor error', async ({ page }) => {
  const fixture = createMfaFixture()
  let refreshRequests = 0
  let verifyAttempts = 0

  await page.route(apiRoute('/auth/login'), route => route.fulfill({
    status: 202,
    json: {
      status: 'mfa_required',
      challengeId: fixture.challengeId,
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  }))
  await page.route(apiRoute('/auth/mfa/verify'), route => {
    verifyAttempts += 1
    if (verifyAttempts === 1) {
      return route.fulfill({
        status: 401,
        json: { error: { code: 'MFA_VERIFICATION_FAILED', message: 'MFA 验证失败' } },
      })
    }
    return route.fulfill({ json: { user: profile, accessToken: 'm3-verified-access-token', recoveryCodeRemaining: 9 } })
  })
  await page.route(apiRoute('/auth/refresh'), route => {
    refreshRequests += 1
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'not used' } } })
  })
  await mockAuthenticatedAppRequests(page)

  await page.goto('/login')
  await page.getByLabel('邮箱地址').fill(profile.email)
  await page.getByLabel('密码（至少 6 位）').fill('not-a-real-password')
  await page.getByRole('button', { name: '登录' }).click()

  await expect(page.getByTestId('mfa-verification')).toBeVisible()
  await page.getByTestId('mfa-use-recovery-code').click()
  await page.getByTestId('mfa-factor-code').fill('not-a-real-recovery-code')
  await page.getByTestId('mfa-verify').click()
  await expect(page.getByText('MFA 验证失败')).toBeVisible()
  await expect(page.getByTestId('mfa-factor-code')).toHaveValue('')
  expect(refreshRequests).toBe(0)

  await page.getByTestId('mfa-factor-code').fill('another-not-a-real-recovery-code')
  await page.getByTestId('mfa-verify').click()
  await expect(page).toHaveURL(/\/$/)
})

test('shows safe session summaries and confirms non-current device revocation', async ({ page }) => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const currentSession = `current-${nonce}`
  const otherSession = `other-${nonce}`
  let sessions = [
    {
      sessionId: currentSession,
      deviceLabel: '当前浏览器',
      ipHint: '203.0.113.*',
      sessionStartedAt: '2030-01-01T00:00:00.000Z',
      lastUsedAt: '2030-01-01T00:01:00.000Z',
      current: true,
    },
    {
      sessionId: otherSession,
      deviceLabel: '另一台浏览器',
      ipHint: '198.51.100.*',
      sessionStartedAt: '2030-01-01T00:00:00.000Z',
      lastUsedAt: '2030-01-01T00:00:30.000Z',
      current: false,
    },
  ]

  await mockNormalLogin(page)
  await page.route(apiRoute('/auth/sessions'), route => route.fulfill({ json: { items: sessions } }))
  await page.route(apiRoute(`/auth/sessions/${otherSession}`), route => {
    sessions = sessions.filter(session => session.sessionId !== otherSession)
    return route.fulfill({ status: 204 })
  })

  await loginThroughPage(page)
  await goToProfile(page)

  await expect(page.getByTestId('session-current-badge')).toBeVisible()
  await expect(page.getByText('当前浏览器')).toBeVisible()
  await expect(page.getByText('203.0.113.*')).toBeVisible()
  await expect(page.getByTestId('session-revoke-device')).toHaveCount(1)

  await page.getByTestId('session-revoke-device').click()
  await expect(page.getByRole('heading', { name: '退出此设备？' })).toBeVisible()
  await page.getByRole('button', { name: '确认退出' }).click()
  await expect(page.getByText('另一台浏览器')).toHaveCount(0)
})

test('confirms revoking all other devices while retaining the current session', async ({ page }) => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const currentSession = `current-${nonce}`
  const otherSession = `other-${nonce}`
  let revokeOtherCalls = 0

  await mockNormalLogin(page)
  await page.route(apiRoute('/auth/sessions'), route => route.fulfill({ json: {
    items: [
      {
        sessionId: currentSession,
        deviceLabel: '当前浏览器',
        ipHint: '203.0.113.*',
        sessionStartedAt: '2030-01-01T00:00:00.000Z',
        lastUsedAt: '2030-01-01T00:01:00.000Z',
        current: true,
      },
      {
        sessionId: otherSession,
        deviceLabel: '另一台浏览器',
        ipHint: '198.51.100.*',
        sessionStartedAt: '2030-01-01T00:00:00.000Z',
        lastUsedAt: '2030-01-01T00:00:30.000Z',
        current: false,
      },
    ],
  } }))
  await page.route(apiRoute('/auth/sessions/revoke-others'), route => {
    revokeOtherCalls += 1
    return route.fulfill({ json: { revokedCount: 1 } })
  })

  await loginThroughPage(page)
  await goToProfile(page)

  await page.getByTestId('session-revoke-others').click()
  await expect(page.getByRole('heading', { name: '退出其他设备？' })).toBeVisible()
  await page.getByRole('button', { name: '确认退出' }).click()
  expect(revokeOtherCalls).toBe(1)
  await expect(page.getByText('已退出其他 1 台设备')).toBeVisible()
})

test('keeps MFA enrollment usable without horizontal overflow at 320px', async ({ page }) => {
  const fixture = createMfaFixture()
  await page.setViewportSize({ width: 320, height: 900 })

  await page.route(apiRoute('/auth/login'), route => route.fulfill({
    status: 202,
    json: {
      status: 'mfa_enrollment_required',
      challengeId: fixture.challengeId,
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  }))
  await page.route(apiRoute('/auth/mfa/enrollment/start'), route => route.fulfill({ json: {
    provisioningUri: fixture.provisioningUri,
    manualKey: fixture.manualKey,
    expiresAt: '2030-01-01T00:00:00.000Z',
  } }))
  await mockAuthenticatedAppRequests(page)

  await page.goto('/login')
  await page.getByLabel('邮箱地址').fill(profile.email)
  await page.getByLabel('密码（至少 6 位）').fill('not-a-real-password')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByTestId('mfa-enrollment')).toBeVisible()
  await expect(page.getByTestId('mfa-enrollment-confirm')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('keeps device-session controls usable without horizontal overflow at 375px', async ({ page }) => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  await page.setViewportSize({ width: 375, height: 900 })

  await mockNormalLogin(page)
  await page.route(apiRoute('/auth/sessions'), route => route.fulfill({ json: {
    items: [
      {
        sessionId: `current-${nonce}`,
        deviceLabel: '当前浏览器',
        ipHint: '203.0.113.*',
        sessionStartedAt: '2030-01-01T00:00:00.000Z',
        lastUsedAt: '2030-01-01T00:01:00.000Z',
        current: true,
      },
      {
        sessionId: `other-${nonce}`,
        deviceLabel: '另一台浏览器',
        ipHint: '198.51.100.*',
        sessionStartedAt: '2030-01-01T00:00:00.000Z',
        lastUsedAt: '2030-01-01T00:00:30.000Z',
        current: false,
      },
    ],
  } }))

  await loginThroughPage(page)
  await goToProfile(page)
  await expect(page.getByTestId('session-revoke-others')).toBeVisible()
  await expect(page.getByTestId('session-revoke-device')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})
