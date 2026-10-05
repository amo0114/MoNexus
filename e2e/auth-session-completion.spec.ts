import { expect, test, type BrowserContext, type Page } from '@playwright/test'

type TestUser = {
  id: number
  email: string
  nickname: string
  role: 'user'
  status: '正常'
  points: number
  merchant: null
}

type DeferredResponse = {
  promise: Promise<void>
  resolve: () => void
}

const userA: TestUser = {
  id: 801,
  email: 'session-a@browser.test',
  nickname: 'Session A',
  role: 'user',
  status: '正常',
  points: 100,
  merchant: null,
}

const userB: TestUser = {
  id: 802,
  email: 'session-b@browser.test',
  nickname: 'Session B',
  role: 'user',
  status: '正常',
  points: 200,
  merchant: null,
}

const registry = {
  productTypes: [],
  deliveryModes: [],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 20, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
  capabilities: { notifications: false, notificationRealtime: false },
  memberTiers: [],
  memberTierThresholds: { silver: 1_000, gold: 5_000, platinum: 10_000 },
  memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
}

function createAccessToken(user: TestUser, sessionId: string): string {
  const encodedPayload = Buffer.from(JSON.stringify({
    userId: user.id,
    role: user.role,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url')
  return `header.${encodedPayload}.signature`
}

function decodeAccessTokenUserId(accessToken: string): number {
  return Number(JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).userId)
}

function deferredResponse(): DeferredResponse {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function installMockApi(context: BrowserContext, options: { mfaUserId?: number } = {}) {
  const loginUserIds: number[] = []
  const profileUserIds: number[] = []
  const apiPaths: string[] = []
  const browserErrors: string[] = []
  const observePageErrors = (page: Page) => {
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
  }
  context.pages().forEach(observePageErrors)
  const profileGates = new Map([
    [userA.id, deferredResponse()],
    [userB.id, deferredResponse()],
  ])
  const mfaFixtureUser = options.mfaUserId === userA.id ? userA : null

  await context.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
    const request = route.request()
    const requestUrl = new URL(request.url())
    const requestPath = requestUrl.pathname
    apiPaths.push(`${request.method()} ${requestPath}`)

    if (requestPath === '/api/auth/registration-status') {
      await route.fulfill({ json: {
        registrationEnabled: true,
        registrationAvailable: true,
        inviteRequired: false,
        challenge: null,
        legalRequirement: null,
      } })
      return
    }

    if (requestPath === '/api/auth/login') {
      const requestBody = request.postDataJSON() as { email: string }
      const selectedUser = [userA, userB].find((user) => user.email === requestBody.email)
      if (!selectedUser) {
        await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'bad test account' } } })
        return
      }

      loginUserIds.push(selectedUser.id)
      if (selectedUser.id === mfaFixtureUser?.id) {
        await route.fulfill({
          status: 202,
          json: {
            status: 'mfa_enrollment_required',
            challengeId: 'browser-mfa-challenge',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
        return
      }

      const accessToken = createAccessToken(selectedUser, `session-${selectedUser.id}`)
      await route.fulfill({
        headers: { 'Set-Cookie': `refreshToken=refresh-${selectedUser.id}; Path=/; HttpOnly; SameSite=Lax` },
        json: { user: selectedUser, accessToken },
      })
      return
    }

    if (requestPath === '/api/auth/mfa/enrollment/start') {
      await route.fulfill({ json: {
        provisioningUri: 'otpauth://totp/MoNexus:browser-test?secret=BROWSERTESTKEY',
        manualKey: 'BROWSERTESTKEY',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } })
      return
    }

    if (requestPath === '/api/auth/mfa/enrollment/confirm') {
      const accessToken = createAccessToken(userA, 'session-mfa-pending-a')
      await route.fulfill({
        status: 201,
        headers: { 'Set-Cookie': 'refreshToken=refresh-mfa-a; Path=/; HttpOnly; SameSite=Lax' },
        json: { user: userA, accessToken, recoveryCodes: ['not-a-real-recovery-code'] },
      })
      return
    }

    if (requestPath === '/api/auth/me') {
      const authorization = request.headers().authorization ?? ''
      const accessToken = authorization.replace(/^Bearer\s+/i, '')
      const userId = decodeAccessTokenUserId(accessToken)
      const profileUser = [userA, userB].find((user) => user.id === userId)
      if (!profileUser) {
        await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'invalid test token' } } })
        return
      }

      profileUserIds.push(userId)
      await profileGates.get(userId)!.promise
      await route.fulfill({ json: profileUser })
      return
    }

    if (requestPath === '/api/config/registry') {
      await route.fulfill({ json: registry })
      return
    }
    if (requestPath === '/api/announcements') {
      await route.fulfill({ json: [] })
      return
    }
    if (requestPath === '/api/notifications/stream') {
      await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'disabled in test' } } })
      return
    }
    if (requestPath === '/api/notifications/unread-count') {
      await route.fulfill({ json: { count: 0 } })
      return
    }
    if (requestPath === '/api/notifications') {
      await route.fulfill({ json: { notifications: [], nextCursor: null, hasMore: false } })
      return
    }
    if (requestPath === '/api/orders/attention-count') {
      await route.fulfill({ json: { count: 0 } })
      return
    }
    if (requestPath === '/api/products/sponsored' || requestPath === '/api/products/editorial') {
      await route.fulfill({ json: { items: [] } })
      return
    }
    if (requestPath === '/api/products') {
      await route.fulfill({ json: { items: [], nextCursor: null, hasMore: false } })
      return
    }

    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'test route not mocked' } } })
  })

  context.on('page', observePageErrors)
  return { loginUserIds, profileUserIds, profileGates, apiPaths, browserErrors }
}

async function submitLogin(page: Page, user: TestUser): Promise<void> {
  if (!new URL(page.url()).pathname.endsWith('/login')) await page.goto('/login')
  await page.getByLabel('邮箱地址').fill(user.email)
  await page.getByLabel('密码（至少 6 位）').fill('correct-test-password')
  await page.getByRole('button', { name: '登录' }).click()
}

test('serializes a second tab login until the first tab profile commit finishes', async ({ browser }) => {
  const context = await browser.newContext()
  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  const fixture = await installMockApi(context)

  await Promise.all([firstPage.goto('/login'), secondPage.goto('/login')])
  expect(await firstPage.evaluate(() => Boolean(navigator.locks))).toBe(true)
  const firstLogin = submitLogin(firstPage, userA)
  try {
    await expect.poll(() => fixture.profileUserIds).toEqual([userA.id])
  } catch (error) {
    throw new Error(JSON.stringify({
      logins: fixture.loginUserIds,
      profiles: fixture.profileUserIds,
      paths: fixture.apiPaths,
      errors: fixture.browserErrors,
    }), { cause: error })
  }

  const secondLogin = submitLogin(secondPage, userB)
  await secondLogin
  await expect.poll(() => secondPage.evaluate(async () => {
    const locks = await navigator.locks.query()
    return locks.pending?.some((lock) => lock.name === 'monexus-auth-cookie-mutation') ?? false
  })).toBe(true)
  expect(fixture.loginUserIds).toEqual([userA.id])

  fixture.profileGates.get(userA.id)!.resolve()
  await expect.poll(() => fixture.profileUserIds.includes(userB.id)).toBe(true)
  const cookieBeforeSecondProfileCommit = await context.cookies(new URL(secondPage.url()).origin)
  expect(cookieBeforeSecondProfileCommit.find((cookie) => cookie.name === 'refreshToken')?.value)
    .toBe(`refresh-${userB.id}`)

  fixture.profileGates.get(userB.id)!.resolve()
  await Promise.all([firstLogin, secondLogin])
  await expect(firstPage).toHaveURL(/\/$/)
  await expect(secondPage).toHaveURL(/\/$/)

  const persistedAuth = await secondPage.evaluate(() => JSON.parse(localStorage.getItem('monexus-auth') ?? 'null'))
  expect(persistedAuth.state.user.id).toBe(userB.id)
  expect(decodeAccessTokenUserId(persistedAuth.state.accessToken)).toBe(userB.id)
  const finalCookie = await context.cookies(new URL(secondPage.url()).origin)
  expect(finalCookie.find((cookie) => cookie.name === 'refreshToken')?.value).toBe(`refresh-${userB.id}`)

  await context.close()
})

test('does not commit an MFA enrollment session after another tab completes a newer login', async ({ browser }) => {
  const context = await browser.newContext()
  const mfaPage = await context.newPage()
  const newerLoginPage = await context.newPage()
  const fixture = await installMockApi(context, { mfaUserId: userA.id })

  await mfaPage.goto('/login')
  const mfaLogin = submitLogin(mfaPage, userA)
  try {
    await expect(mfaPage.getByTestId('mfa-enrollment')).toBeVisible()
  } catch (error) {
    throw new Error(JSON.stringify({
      logins: fixture.loginUserIds,
      profiles: fixture.profileUserIds,
      paths: fixture.apiPaths,
      errors: fixture.browserErrors,
    }), { cause: error })
  }
  await mfaPage.getByTestId('mfa-factor-code').fill('123456')
  await mfaPage.getByTestId('mfa-enrollment-confirm').click()
  await expect(mfaPage.getByTestId('mfa-recovery-codes')).toBeVisible()
  await expect(mfaPage.getByTestId('mfa-recovery-continue')).toBeDisabled()

  await submitLogin(newerLoginPage, userB)
  await expect.poll(() => fixture.profileUserIds).toContain(userB.id)
  fixture.profileGates.get(userB.id)!.resolve()

  await expect(newerLoginPage).toHaveURL(/\/$/)
  await expect(mfaPage.getByTestId('mfa-recovery-codes')).toHaveCount(0)
  expect(fixture.profileUserIds).not.toContain(userA.id)
  const persistedAuth = await mfaPage.evaluate(() => JSON.parse(localStorage.getItem('monexus-auth') ?? 'null'))
  expect(persistedAuth.state.user.id).toBe(userB.id)
  expect(decodeAccessTokenUserId(persistedAuth.state.accessToken)).toBe(userB.id)
  const finalCookie = await context.cookies(new URL(newerLoginPage.url()).origin)
  expect(finalCookie.find((cookie) => cookie.name === 'refreshToken')?.value).toBe(`refresh-${userB.id}`)

  await Promise.all([mfaLogin, context.close()])
})
