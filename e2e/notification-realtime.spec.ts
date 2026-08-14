import { execFileSync } from 'node:child_process'
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

/**
 * SPEC-NOTIFY-RT-001 — real browser acceptance suite.
 *
 * Contract for this file:
 *  - real PostgreSQL, backend (3112), Vite (5182), auth and fetch SSE;
 *  - APIs are used only to arrange data or trigger the business action;
 *  - acceptance is asserted from DOM or the browser's actual stream lifecycle;
 *  - no document refresh or test-driven target GET/state polling.
 */

const API_BASE = 'http://127.0.0.1:3112/api'
const NORMAL_LIMIT_MS = 5_000
const FALLBACK_LIMIT_MS = 35_000
const STREAM_BOOT_LIMIT_MS = 15_000

type SeedScenario = 'base' | 'pagination' | 'announcement'

interface RealtimeFixture {
  scenario: SeedScenario
  password: string
  merchantUserId: number
  merchantEmail: string
  merchantNickname: string
  merchantToken: string
  buyerUserId: number
  buyerEmail: string
  buyerNickname: string
  buyerToken: string
  buyerBUserId: number
  buyerBEmail: string
  buyerBNickname: string
  buyerBToken: string
  productId: number
  offerId: number
  productName: string
  instantProductId: number
  instantOfferId: number
  instantProductName: string
  instantSecret: string
  historyOrderIds: number[]
  systemNotificationId: number | null
  announcementId: number | null
  announcementTitle: string | null
}

interface ProbeRequest {
  authorization: string | null
  status: number | null
  aborted: boolean
}

interface ProbeSnapshot {
  text: string
  aborts: number
  requests: ProbeRequest[]
}

function seedFixture(scenario: SeedScenario = 'base'): RealtimeFixture {
  const output = execFileSync(
    'node',
    ['--import', 'tsx', 'scripts/notification-realtime-e2e-seed.mjs'],
    {
      cwd: 'server',
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
        JWT_SECRET: 'test-secret-key-at-least-32-characters-long!!',
        FRONTEND_ORIGIN: 'http://localhost:5182',
        COOKIE_SECURE: 'false',
        NODE_ENV: 'test',
        RT_E2E_SCENARIO: scenario,
      },
    },
  )
  return JSON.parse(output.trim()) as RealtimeFixture
}

function userSession(fixture: RealtimeFixture, actor: 'merchant' | 'buyer' | 'buyerB') {
  if (actor === 'merchant') {
    return {
      token: fixture.merchantToken,
      user: {
        id: fixture.merchantUserId,
        role: 'merchant',
        email: fixture.merchantEmail,
        nickname: fixture.merchantNickname,
        points: 0,
      },
    }
  }
  if (actor === 'buyerB') {
    return {
      token: fixture.buyerBToken,
      user: {
        id: fixture.buyerBUserId,
        role: 'user',
        email: fixture.buyerBEmail,
        nickname: fixture.buyerBNickname,
        points: 100000,
      },
    }
  }
  return {
    token: fixture.buyerToken,
    user: {
      id: fixture.buyerUserId,
      role: 'user',
      email: fixture.buyerEmail,
      nickname: fixture.buyerNickname,
      points: 100000,
    },
  }
}

async function injectSession(
  page: Page,
  fixture: RealtimeFixture,
  actor: 'merchant' | 'buyer' | 'buyerB',
) {
  const session = userSession(fixture, actor)
  await page.addInitScript(({ token, user }) => {
    window.localStorage.setItem('monexus-auth', JSON.stringify({
      state: { user, isLoggedIn: true, accessToken: token },
      version: 0,
    }))
  }, session)
}

/**
 * Observe the actual fetch SSE without replacing it. The response body is
 * tee'd: the application consumes one branch and the probe drains the other.
 * This gives event/secret/abort evidence without mocking a success frame.
 */
async function installRealtimeProbe(page: Page) {
  await page.addInitScript(() => {
    type RequestRecord = {
      authorization: string | null
      status: number | null
      aborted: boolean
    }
    type Probe = {
      snapshot: () => { text: string; aborts: number; requests: RequestRecord[] }
      resetText: () => void
      waitForText: (needle: string, timeoutMs: number) => Promise<void>
      waitForAbort: (after: number, timeoutMs: number) => Promise<void>
      waitForStatus: (status: number, timeoutMs: number) => Promise<void>
    }
    const target = window as typeof window & { __MONEXUS_RT_E2E_PROBE__?: Probe }
    if (target.__MONEXUS_RT_E2E_PROBE__) return

    const originalFetch = window.fetch.bind(window)
    const requests: RequestRecord[] = []
    const listeners = new Set<() => void>()
    let streamText = ''
    let aborts = 0

    const notify = () => {
      for (const listener of [...listeners]) listener()
    }
    const waitFor = (predicate: () => boolean, timeoutMs: number) => new Promise<void>((resolve, reject) => {
      if (predicate()) {
        resolve()
        return
      }
      const timer = window.setTimeout(() => {
        listeners.delete(check)
        reject(new Error('realtime probe timeout'))
      }, timeoutMs)
      const check = () => {
        if (!predicate()) return
        window.clearTimeout(timer)
        listeners.delete(check)
        resolve()
      }
      listeners.add(check)
    })

    target.__MONEXUS_RT_E2E_PROBE__ = {
      snapshot: () => ({
        text: streamText,
        aborts,
        requests: requests.map((request) => ({ ...request })),
      }),
      resetText: () => { streamText = '' },
      waitForText: (needle, timeoutMs) => waitFor(() => streamText.includes(needle), timeoutMs),
      waitForAbort: (after, timeoutMs) => waitFor(() => aborts > after, timeoutMs),
      waitForStatus: (status, timeoutMs) => waitFor(
        () => requests.some((request) => request.status === status),
        timeoutMs,
      ),
    }

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      const url = new URL(rawUrl, window.location.origin)
      if (url.pathname !== '/api/notifications/stream') return originalFetch(input, init)

      const request = new Request(input, init)
      const record: RequestRecord = {
        authorization: request.headers.get('Authorization'),
        status: null,
        aborted: request.signal.aborted,
      }
      requests.push(record)
      request.signal.addEventListener('abort', () => {
        if (record.aborted) return
        record.aborted = true
        aborts += 1
        notify()
      }, { once: true })
      notify()

      const response = await originalFetch(request)
      record.status = response.status
      notify()
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        return response
      }

      const [applicationBody, inspectionBody] = response.body.tee()
      void (async () => {
        const reader = inspectionBody.getReader()
        const decoder = new TextDecoder()
        try {
          while (true) {
            const result = await reader.read()
            if (result.done) break
            streamText = (streamText + decoder.decode(result.value, { stream: true })).slice(-262_144)
            notify()
          }
          streamText = (streamText + decoder.decode()).slice(-262_144)
          notify()
        } catch {
          // Abort/EOF is represented by the request record; no probe-side retry.
        }
      })()

      return new Response(applicationBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }) as typeof window.fetch
  })
}

async function probeSnapshot(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (window as typeof window & {
      __MONEXUS_RT_E2E_PROBE__?: { snapshot: () => ProbeSnapshot }
    }).__MONEXUS_RT_E2E_PROBE__
    if (!probe) throw new Error('realtime probe missing')
    return probe.snapshot()
  })
}

async function waitForProbeText(page: Page, needle: string, timeoutMs = NORMAL_LIMIT_MS) {
  await page.evaluate(
    ({ expected, timeout }) => {
      const probe = (window as typeof window & {
        __MONEXUS_RT_E2E_PROBE__?: { waitForText: (value: string, ms: number) => Promise<void> }
      }).__MONEXUS_RT_E2E_PROBE__
      if (!probe) throw new Error('realtime probe missing')
      return probe.waitForText(expected, timeout)
    },
    { expected: needle, timeout: timeoutMs },
  )
}

async function waitForStreamReady(page: Page) {
  await waitForProbeText(page, 'stream.ready', STREAM_BOOT_LIMIT_MS)
}

async function waitForProbeStatus(page: Page, status: number, timeoutMs = NORMAL_LIMIT_MS) {
  await page.evaluate(
    ({ expected, timeout }) => {
      const probe = (window as typeof window & {
        __MONEXUS_RT_E2E_PROBE__?: { waitForStatus: (value: number, ms: number) => Promise<void> }
      }).__MONEXUS_RT_E2E_PROBE__
      if (!probe) throw new Error('realtime probe missing')
      return probe.waitForStatus(expected, timeout)
    },
    { expected: status, timeout: timeoutMs },
  )
}

async function resetProbeText(page: Page) {
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __MONEXUS_RT_E2E_PROBE__?: { resetText: () => void }
    }).__MONEXUS_RT_E2E_PROBE__
    if (!probe) throw new Error('realtime probe missing')
    probe.resetText()
  })
}

async function waitForProbeAbort(page: Page, after: number, timeoutMs = NORMAL_LIMIT_MS) {
  await page.evaluate(
    ({ baseline, timeout }) => {
      const probe = (window as typeof window & {
        __MONEXUS_RT_E2E_PROBE__?: { waitForAbort: (value: number, ms: number) => Promise<void> }
      }).__MONEXUS_RT_E2E_PROBE__
      if (!probe) throw new Error('realtime probe missing')
      return probe.waitForAbort(baseline, timeout)
    },
    { baseline: after, timeout: timeoutMs },
  )
}

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data?: Record<string, unknown>,
): Promise<T> {
  const response = await request.post(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  })
  const text = await response.text()
  expect(response.ok(), `${response.status()} ${path}: ${text.slice(0, 500)}`).toBeTruthy()
  return (text ? JSON.parse(text) : null) as T
}

async function createManualOrder(
  request: APIRequestContext,
  fixture: RealtimeFixture,
  token = fixture.buyerToken,
) {
  return postJson<{ orderId: number }>(request, '/orders', token, {
    productId: fixture.productId,
    offerId: fixture.offerId,
    expectedPrice: 100,
  })
}

async function startFulfillment(request: APIRequestContext, fixture: RealtimeFixture, orderId: number) {
  await postJson<unknown>(
    request,
    `/merchant/orders/${orderId}/fulfillment/start`,
    fixture.merchantToken,
    {},
  )
}

async function deliver(
  request: APIRequestContext,
  fixture: RealtimeFixture,
  orderId: number,
  deliveryContent: string,
) {
  await postJson<unknown>(
    request,
    `/merchant/orders/${orderId}/fulfillment/deliver`,
    fixture.merchantToken,
    { deliveryContent },
  )
}

async function expectOrderStatus(page: Page, orderId: number, status: string, timeout = NORMAL_LIMIT_MS) {
  await expect(page.getByTestId(`buyer-order-status-${orderId}`)).toHaveAttribute(
    'data-order-status',
    status,
    { timeout },
  )
}

async function notificationItemIds(page: Page) {
  return page.locator('[data-testid^="notification-item-"]').evaluateAll((nodes) => nodes.map((node) => {
    const value = node.getAttribute('data-testid') ?? ''
    return Number(value.replace('notification-item-', ''))
  }))
}

async function openDesktopCenter(page: Page) {
  await page.getByTestId('announcement-center-desktop-trigger').click()
  await expect(page.getByTestId('announcement-center')).toBeVisible()
}

async function submitPasswordLogin(page: Page, email: string, password: string) {
  await page.getByPlaceholder('邮箱地址').fill(email)
  await page.getByPlaceholder('密码（至少 6 位）').fill(password)
  const loginResponse = page.waitForResponse((response) => (
    response.url().includes('/api/auth/login') && response.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: '登录' }).click()
  expect((await loginResponse).status()).toBe(200)
  await expect(page).toHaveURL(/\/$/)
}

test('merchant sees a buyer-created manual order without refresh (AC-RT-001)', async ({ page }) => {
  const fixture = seedFixture()
  await installRealtimeProbe(page)
  await injectSession(page, fixture, 'merchant')
  await page.goto('/merchant/dashboard', { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(/\/merchant\/dashboard/)
  await waitForStreamReady(page)

  await createManualOrder(page.request, fixture)

  const badge = page.getByTestId('notification-bell-total-count')
  await expect(badge).toHaveText('1', { timeout: NORMAL_LIMIT_MS })
  await expect(page.locator('[data-toast-card]').filter({ hasText: '新的待处理订单' })).toBeVisible()
})

test('processing and delivery update buyer list, attention, open detail and messages without leaking delivery content (AC-RT-002)', async ({ page }) => {
  const fixture = seedFixture()
  const { orderId } = await createManualOrder(page.request, fixture)
  const deliverySecret = `RT-MANUAL-DELIVERY-${orderId}`

  await installRealtimeProbe(page)
  await injectSession(page, fixture, 'buyer')
  await page.goto(`/orders?focus=${orderId}`, { waitUntil: 'domcontentloaded' })
  await waitForStreamReady(page)
  await expect(page.getByTestId(`buyer-order-card-${orderId}`)).toBeVisible()
  await expectOrderStatus(page, orderId, 'pending')
  await expect(page.getByTestId('order-detail-status')).toHaveAttribute('data-order-status', 'pending')
  await expect(page.getByTestId('orders-attention-summary')).toContainText('进行中 1 单')

  const processingStarted = Date.now()
  await startFulfillment(page.request, fixture, orderId)
  await expectOrderStatus(page, orderId, 'processing')
  await expect(page.getByTestId('order-detail-status')).toHaveAttribute(
    'data-order-status',
    'processing',
    { timeout: NORMAL_LIMIT_MS },
  )
  expect(Date.now() - processingStarted).toBeLessThanOrEqual(NORMAL_LIMIT_MS)

  const deliveredStarted = Date.now()
  await deliver(page.request, fixture, orderId, deliverySecret)
  await expectOrderStatus(page, orderId, 'delivered')
  await expect(page.getByTestId('order-detail-status')).toHaveAttribute(
    'data-order-status',
    'delivered',
    { timeout: NORMAL_LIMIT_MS },
  )
  await expect(page.getByTestId('orders-attention-summary')).not.toContainText('进行中')
  await expect(page.getByTestId('notification-bell-total-count')).toHaveText('2')
  expect(Date.now() - deliveredStarted).toBeLessThanOrEqual(NORMAL_LIMIT_MS)

  const stream = await probeSnapshot(page)
  expect(stream.text).toContain('order.processing_buyer')
  expect(stream.text).toContain('order.delivered_buyer')
  expect(stream.text).toContain(`"relatedOrderId":${orderId}`)
  expect(stream.text).not.toContain(deliverySecret)

  await page.getByTestId('order-detail-close').click()
  await openDesktopCenter(page)
  await page.getByTestId('notification-center-tab-messages').click()
  await expect(
    page.locator('[data-testid^="notification-center-message-"]').filter({ hasText: '订单已发货' }).first(),
  ).toBeVisible()
})

test('blocked stream converges through the application fallback within 35 seconds without refresh (AC-RT-011)', async ({ page }) => {
  test.setTimeout(60_000)
  const fixture = seedFixture()
  const { orderId } = await createManualOrder(page.request, fixture)
  const documentRequests: string[] = []
  const applicationReads: string[] = []

  await page.route('**/api/notifications/stream', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"blocked-by-ac-rt-011"}' })
  })
  await installRealtimeProbe(page)
  await injectSession(page, fixture, 'buyer')
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.resourceType() === 'document') documentRequests.push(url.pathname)
    if (
      request.method() === 'GET'
      && (
        url.pathname === '/api/orders'
        || url.pathname === `/api/orders/${orderId}`
        || url.pathname === '/api/notifications/unread-count'
      )
    ) applicationReads.push(url.pathname)
  })

  await page.goto(`/orders?focus=${orderId}`, { waitUntil: 'domcontentloaded' })
  await waitForProbeStatus(page, 503)
  await expectOrderStatus(page, orderId, 'pending')
  await expect(page.getByTestId('order-detail-status')).toHaveAttribute('data-order-status', 'pending')
  const navigationBaseline = documentRequests.length
  applicationReads.length = 0

  const fallbackStarted = Date.now()
  await startFulfillment(page.request, fixture, orderId)
  await deliver(page.request, fixture, orderId, `RT-FALLBACK-DELIVERY-${orderId}`)

  await expectOrderStatus(page, orderId, 'delivered', FALLBACK_LIMIT_MS)
  await expect(page.getByTestId('order-detail-status')).toHaveAttribute(
    'data-order-status',
    'delivered',
    { timeout: FALLBACK_LIMIT_MS },
  )
  await expect(page.getByTestId('notification-bell-total-count')).toHaveText('2', {
    timeout: FALLBACK_LIMIT_MS,
  })
  expect(Date.now() - fallbackStarted).toBeLessThanOrEqual(FALLBACK_LIMIT_MS)
  expect(documentRequests).toHaveLength(navigationBaseline)
  expect(applicationReads).toContain('/api/orders')
  expect(applicationReads).toContain(`/api/orders/${orderId}`)
  expect(applicationReads).toContain('/api/notifications/unread-count')
})

test('current notification filter keeps two-page cursor history stable when a new first-page item arrives (AC-RT-012)', async ({ page }) => {
  const fixture = seedFixture('pagination')
  const { orderId } = await createManualOrder(page.request, fixture)
  const listRequests: string[] = []

  await installRealtimeProbe(page)
  await injectSession(page, fixture, 'buyer')
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/notifications') {
      listRequests.push(url.toString())
    }
  })
  await page.goto('/notifications', { waitUntil: 'domcontentloaded' })
  await waitForStreamReady(page)
  await page.getByTestId('notifications-tab-order').click()
  await expect(page.getByTestId('notifications-tab-order')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-testid^="notification-item-"]')).toHaveCount(20)
  await expect(page.getByTestId(`notification-item-${fixture.systemNotificationId}`)).toHaveCount(0)

  await page.getByTestId('notifications-load-more').click()
  await expect(page.locator('[data-testid^="notification-item-"]')).toHaveCount(40)
  const firstTwoPages = await notificationItemIds(page)
  expect(new Set(firstTwoPages).size).toBe(40)
  expect(firstTwoPages.every((id) => fixture.historyOrderIds.includes(id))).toBe(true)

  const categoryRequestsBefore = listRequests
    .map((value) => new URL(value))
    .filter((url) => url.searchParams.get('category') === 'order')
  const firstHistoryCursor = categoryRequestsBefore.find((url) => url.searchParams.has('cursor'))
    ?.searchParams.get('cursor')
  expect(firstHistoryCursor).toMatch(/^\d+$/)

  const realtimeStarted = Date.now()
  await startFulfillment(page.request, fixture, orderId)
  const newItem = page.locator(
    `[data-notification-event="order.processing_buyer"][data-related-order-id="${orderId}"]`,
  )
  await expect(newItem).toBeVisible({ timeout: NORMAL_LIMIT_MS })
  await expect(page.getByTestId('notifications-list').locator('li').first().locator('button')).toHaveAttribute(
    'data-related-order-id',
    String(orderId),
  )
  await expect(page.getByTestId('notifications-tab-order')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-testid^="notification-item-"]')).toHaveCount(41)
  expect(Date.now() - realtimeStarted).toBeLessThanOrEqual(NORMAL_LIMIT_MS)

  await page.getByTestId('notifications-load-more').click()
  await expect(page.locator('[data-testid^="notification-item-"]')).toHaveCount(46)
  const allIds = await notificationItemIds(page)
  expect(new Set(allIds).size).toBe(46)
  expect(fixture.historyOrderIds.every((id) => allIds.includes(id))).toBe(true)
  await expect(page.getByTestId(`notification-item-${fixture.systemNotificationId}`)).toHaveCount(0)
  const categories = await page.locator('[data-testid^="notification-item-"]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-notification-category')),
  )
  expect(new Set(categories)).toEqual(new Set(['order']))

  const categoryRequestsAfter = listRequests
    .map((value) => new URL(value))
    .filter((url) => url.searchParams.get('category') === 'order' && url.searchParams.has('cursor'))
  expect(categoryRequestsAfter.length).toBeGreaterThanOrEqual(2)
  const continuedCursor = categoryRequestsAfter.at(-1)?.searchParams.get('cursor')
  expect(Number(continuedCursor)).toBeLessThan(Number(firstHistoryCursor))
})

test('instant delivery updates the buyer silently and emits no merchant new-order event (AC-RT-013)', async ({ page, browser }) => {
  const fixture = seedFixture()
  const merchantContext = await browser.newContext({ baseURL: 'http://localhost:5182' })
  const merchantPage = await merchantContext.newPage()
  try {
    await installRealtimeProbe(page)
    await injectSession(page, fixture, 'buyer')
    await installRealtimeProbe(merchantPage)
    await injectSession(merchantPage, fixture, 'merchant')
    await page.goto('/orders', { waitUntil: 'domcontentloaded' })
    await merchantPage.goto('/merchant/dashboard', { waitUntil: 'domcontentloaded' })
    await Promise.all([
      waitForStreamReady(page),
      waitForStreamReady(merchantPage),
    ])
    await expect(page.locator('[data-toast-card]')).toHaveCount(0)
    await expect(merchantPage.locator('[data-toast-card]')).toHaveCount(0)
    await expect(merchantPage.getByTestId('notification-bell-total-dot')).toHaveCount(0)

    const instantStarted = Date.now()
    const result = await postJson<{ orderId: number }>(page.request, '/orders', fixture.buyerToken, {
      productId: fixture.instantProductId,
      offerId: fixture.instantOfferId,
      expectedPrice: 30,
    })
    await expect(page.getByTestId(`buyer-order-card-${result.orderId}`)).toBeVisible({ timeout: NORMAL_LIMIT_MS })
    await expectOrderStatus(page, result.orderId, 'delivered')
    await expect(page.getByTestId('notification-bell-total-count')).toHaveText('1')
    expect(Date.now() - instantStarted).toBeLessThanOrEqual(NORMAL_LIMIT_MS)

    const remaining = NORMAL_LIMIT_MS - (Date.now() - instantStarted)
    if (remaining > 0) await page.waitForTimeout(remaining)
    await expect(page.locator('[data-toast-card]').filter({ hasText: '订单已交付' })).toHaveCount(0)
    await expect(merchantPage.locator('[data-toast-card]').filter({ hasText: '新的待处理订单' })).toHaveCount(0)
    await expect(merchantPage.getByTestId('notification-bell-total-dot')).toHaveCount(0)

    const buyerStream = await probeSnapshot(page)
    const merchantStream = await probeSnapshot(merchantPage)
    expect(buyerStream.text).toContain('order.delivered_buyer')
    expect(buyerStream.text).toContain(`"relatedOrderId":${result.orderId}`)
    expect(buyerStream.text).not.toContain(fixture.instantSecret)
    expect(merchantStream.text).not.toContain(`"relatedOrderId":${result.orderId}`)
    expect(merchantStream.text).not.toContain('order.created_merchant')

    await openDesktopCenter(page)
    await page.getByTestId('notification-center-tab-messages').click()
    await expect(
      page.locator('[data-testid^="notification-center-message-"]').filter({ hasText: '订单已交付' }),
    ).toBeVisible()
  } finally {
    await merchantContext.close()
  }
})

test('logout aborts the old stream and a subsequent user receives only their own events (AC-RT-020)', async ({ page }) => {
  test.setTimeout(50_000)
  const fixture = seedFixture()
  const aOrder = await createManualOrder(page.request, fixture, fixture.buyerToken)

  await installRealtimeProbe(page)
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await submitPasswordLogin(page, fixture.buyerEmail, fixture.password)
  await waitForStreamReady(page)
  await page.getByRole('button', { name: '个人中心' }).click()
  await expect(page).toHaveURL(/\/profile/)
  await expect(page.getByTestId('profile-logout')).toBeVisible()
  const aSnapshot = await probeSnapshot(page)
  const aAuthorization = aSnapshot.requests.at(-1)?.authorization
  expect(aAuthorization).toMatch(/^Bearer /)

  const abortPromise = waitForProbeAbort(page, aSnapshot.aborts)
  await page.getByTestId('profile-logout').click()
  await abortPromise
  await expect(page).toHaveURL(/\/login/)
  const loggedOut = await page.evaluate(() => JSON.parse(localStorage.getItem('monexus-auth') ?? '{}'))
  expect(loggedOut.state?.isLoggedIn).toBe(false)
  await resetProbeText(page)

  await submitPasswordLogin(page, fixture.buyerBEmail, fixture.password)
  await waitForStreamReady(page)
  const bSnapshot = await probeSnapshot(page)
  const bAuthorization = bSnapshot.requests.at(-1)?.authorization
  expect(bAuthorization).toMatch(/^Bearer /)
  expect(bAuthorization).not.toBe(aAuthorization)
  expect(bSnapshot.requests.filter((request) => !request.aborted).length).toBeGreaterThanOrEqual(1)

  await expect(page.locator('[data-toast-card]').filter({ hasText: '登录成功' })).toHaveCount(0, {
    timeout: NORMAL_LIMIT_MS,
  })
  await resetProbeText(page)
  await startFulfillment(page.request, fixture, aOrder.orderId)
  await page.waitForTimeout(NORMAL_LIMIT_MS)
  const afterAEvent = await probeSnapshot(page)
  expect(afterAEvent.text).not.toContain(`"relatedOrderId":${aOrder.orderId}`)
  await expect(page.locator('[data-toast-card]').filter({ hasText: '订单处理中' })).toHaveCount(0)
  await expect(page.getByTestId('notification-bell-total-count')).toHaveCount(0)

  const bOrder = await createManualOrder(page.request, fixture, fixture.buyerBToken)
  const bEventStarted = Date.now()
  await startFulfillment(page.request, fixture, bOrder.orderId)
  await waitForProbeText(page, `"relatedOrderId":${bOrder.orderId}`, NORMAL_LIMIT_MS)
  await expect(page.getByTestId('notification-bell-total-count')).toHaveText('1')
  await expect(page.locator('[data-toast-card]').filter({ hasText: '订单处理中' })).toBeVisible()
  expect(Date.now() - bEventStarted).toBeLessThanOrEqual(NORMAL_LIMIT_MS)
})

test('acknowledgement-required announcement and transaction message share one bell without changing acknowledgement semantics (AC-RT-026)', async ({ page }) => {
  const fixture = seedFixture('announcement')
  const { orderId } = await createManualOrder(page.request, fixture)
  expect(fixture.announcementId).not.toBeNull()

  await installRealtimeProbe(page)
  await injectSession(page, fixture, 'buyer')
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitForStreamReady(page)
  await expect(page.getByTestId('announcement-center')).toBeVisible()
  await expect(page.getByTestId('notification-center-tab-announcements')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId(`announcement-item-${fixture.announcementId}`)).toContainText(
    fixture.announcementTitle ?? '',
  )
  await expect(page.getByTestId(`announcement-acknowledge-${fixture.announcementId}`)).toBeVisible()
  await expect(page.getByTestId('notification-bell-total-count')).toHaveText('1')
  await expect(page.getByTestId('announcement-center-desktop-trigger')).toHaveCount(1)
  await expect(page.getByTestId('announcement-center-mobile-trigger')).toHaveCount(1)

  const transactionStarted = Date.now()
  await startFulfillment(page.request, fixture, orderId)
  await expect(page.getByTestId('notification-bell-total-count')).toHaveText('2', {
    timeout: NORMAL_LIMIT_MS,
  })
  await expect(page.getByTestId('notification-center-total-unread')).toHaveText('2 条待处理')
  expect(Date.now() - transactionStarted).toBeLessThanOrEqual(NORMAL_LIMIT_MS)

  await page.getByTestId('notification-center-tab-messages').click()
  await expect(page.getByTestId('notification-center-tab-messages')).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.locator('[data-testid^="notification-center-message-"]').filter({ hasText: '订单处理中' }),
  ).toContainText('未读')

  await page.getByTestId('notification-center-tab-announcements').click()
  const announcementItem = page.getByTestId(`announcement-item-${fixture.announcementId}`)
  await expect(announcementItem).toContainText('待确认')
  const acknowledgeResponse = page.waitForResponse((response) => (
    response.url().endsWith(`/api/announcements/${fixture.announcementId}/acknowledge`)
    && response.request().method() === 'POST'
  ))
  await page.getByTestId(`announcement-acknowledge-${fixture.announcementId}`).click()
  const acknowledged = await acknowledgeResponse
  expect(acknowledged.status()).toBe(200)
  const receipt = await acknowledged.json() as { readAt?: string; acknowledgedAt?: string }
  expect(receipt.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(receipt.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  await expect(page.getByTestId(`announcement-acknowledge-${fixture.announcementId}`)).toHaveCount(0)
  await expect(page.getByTestId('notification-center-tab-messages')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('notification-bell-total-count')).toHaveText('1')
  await expect(page.getByTestId('notification-center-total-unread')).toHaveText('1 条待处理')

  await page.getByTestId('notification-center-tab-announcements').click()
  await expect(announcementItem).toContainText('已确认')
  await page.getByTestId('notification-center-tab-messages').click()
  await expect(
    page.locator('[data-testid^="notification-center-message-"]').filter({ hasText: '订单处理中' }),
  ).toContainText('未读')
})
