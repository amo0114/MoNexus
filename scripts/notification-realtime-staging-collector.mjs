#!/usr/bin/env node
/**
 * SPEC-NOTIFY-RT-001 — remote staging browser evidence collector.
 *
 * Modes:
 *   token    real merchant login -> workflow-private short-lived token file
 *   latency 100 independent order API 2xx -> merchant DOM samples
 *   fallback realtime=off (404) -> application-owned <=35s polling proof
 *   history  post-code-rollback REST history proof
 *
 * Fixture metadata and state contain no password or token. Each mode reads the
 * run-scoped password from stdin and authenticates through the real login API.
 * Uploaded evidence contains only aggregate, non-sensitive data.
 */

import fs from 'node:fs'

const CONFIRMATION = 'monexus-staging-notification-realtime'
const SHA_RE = /^[0-9a-f]{40}$/
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const NORMAL_LIMIT_MS = 5_000
const FALLBACK_LIMIT_MS = 35_000
const TOKEN_REFRESH_LEAD_SECONDS = 120
const FRESH_TOKEN_MIN_SECONDS = 12 * 60
const FRESH_TOKEN_MAX_SECONDS = 16 * 60

function nearestRank(values, percentile) {
  if (values.length === 0) throw new Error('cannot calculate an empty percentile')
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(percentile * sorted.length))
  return sorted[rank - 1]
}

function validateBaseUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('staging collector requires a credential-free HTTPS origin')
  }
  url.pathname = '/'
  return url
}

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function readPassword() {
  const input = fs.readFileSync(0, 'utf8')
  const lines = input.split(/\r?\n/)
  const password = lines.shift() ?? ''
  if (password.length < 20 || lines.some((line) => line.length > 0)) {
    throw new Error('staging fixture password input is invalid')
  }
  return password
}

function tokenExpiry(token) {
  const segments = token.split('.')
  if (segments.length !== 3) throw new Error('login returned a malformed access token')
  let payload
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('login returned an unreadable access token')
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= 0) {
    throw new Error('login returned an access token without a valid expiry')
  }
  return payload.exp
}

function assertFreshToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiresAt = tokenExpiry(token)
  const remaining = expiresAt - nowSeconds
  if (remaining < FRESH_TOKEN_MIN_SECONDS || remaining > FRESH_TOKEN_MAX_SECONDS) {
    throw new Error('login did not return the frozen 15-minute access-token lifetime')
  }
  return expiresAt
}

if (process.argv.includes('--self-test')) {
  const sample = Array.from({ length: 100 }, (_, index) => index + 1)
  if (nearestRank(sample, 0.5) !== 50) process.exit(1)
  if (nearestRank(sample, 0.95) !== 95) process.exit(1)
  if (nearestRank(sample, 0.99) !== 99) process.exit(1)
  const fakeNow = 1_999_999_100
  const fakePayload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')
  const fakeToken = `header.${fakePayload}.signature`
  if (tokenExpiry(fakeToken) !== 2_000_000_000) process.exit(1)
  if (assertFreshToken(fakeToken, fakeNow) !== 2_000_000_000) process.exit(1)
  try {
    validateBaseUrl('http://staging.example.test')
    process.exit(1)
  } catch {
    // expected
  }
  console.log('[PASS] staging collector percentile, token and URL self-test')
  process.exit(0)
}

if (process.env.RT_STAGING_CONFIRM !== CONFIRMATION) throw new Error('staging collector confirmation is missing')
const mode = process.env.RT_STAGING_COLLECTOR_MODE
if (!['token', 'latency', 'fallback', 'history'].includes(mode)) throw new Error('invalid staging collector mode')
const head = process.env.RT_STAGING_HEAD ?? ''
if (!SHA_RE.test(head)) throw new Error('staging collector requires a full commit SHA')
const baseUrl = validateBaseUrl(process.env.RT_STAGING_BASE_URL ?? '')
const fixturePath = process.env.RT_STAGING_FIXTURE_FILE ?? ''
if (!fixturePath) throw new Error('staging fixture metadata path is required')
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
if (fixture.head !== head || !RUN_ID_RE.test(fixture.runId ?? '')) throw new Error('staging fixture identity mismatch')
for (const account of [fixture.merchant, fixture.buyer]) {
  if (
    !Number.isSafeInteger(account?.userId)
    || account.userId <= 0
    || typeof account.email !== 'string'
    || !account.email.endsWith('@fixture.invalid')
  ) throw new Error('staging fixture account metadata is invalid')
}
const statePath = process.env.RT_STAGING_STATE_FILE ?? ''
if (mode !== 'token' && !statePath) throw new Error('staging state file path is required')

function loadState() {
  if (!fs.existsSync(statePath)) return {}
  return JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function saveState(state) {
  writePrivateFile(statePath, `${JSON.stringify(state)}\n`)
}

function agreementVersions(requirement) {
  if (!requirement || !Array.isArray(requirement.required)) return undefined
  return Object.fromEntries(requirement.required.map((item) => [item.document, item.version]))
}

const playwright = await import('@playwright/test')

async function loginAccount(api, account, password) {
  const response = await api.post(new URL('/api/auth/login', baseUrl).href, {
    data: { email: account.email, password },
  })
  if (response.status() !== 200) throw new Error(`fixture login failed with HTTP ${response.status()}`)
  const body = await response.json()
  if (
    !body
    || typeof body.accessToken !== 'string'
    || !body.user
    || body.user.id !== account.userId
    || body.user.email !== account.email
  ) throw new Error('fixture login returned an unexpected account')
  assertFreshToken(body.accessToken)
  const storage = await api.storageState()
  const refreshCookie = storage.cookies.find((cookie) => (
    cookie.name === 'refreshToken'
    && cookie.httpOnly === true
    && cookie.path === '/api/auth'
  ))
  if (!refreshCookie) throw new Error('fixture login did not establish the refresh-cookie contract')
  return { user: body.user, accessToken: body.accessToken }
}

async function createAuthenticatedApi(account, password) {
  const api = await playwright.request.newContext({
    extraHTTPHeaders: { Accept: 'application/json' },
    timeout: 15_000,
  })
  let accessToken
  let expiresAt

  const applySession = (session) => {
    accessToken = session.accessToken
    expiresAt = assertFreshToken(accessToken)
  }
  applySession(await loginAccount(api, account, password))

  const refresh = async () => {
    const response = await api.post(new URL('/api/auth/refresh', baseUrl).href)
    if (response.status() !== 200) throw new Error(`fixture token refresh failed with HTTP ${response.status()}`)
    const body = await response.json()
    if (!body || typeof body.accessToken !== 'string') throw new Error('fixture token refresh returned no token')
    applySession({ accessToken: body.accessToken })
  }

  const request = async (method, path, options = {}) => {
    if (expiresAt - Math.floor(Date.now() / 1000) <= TOKEN_REFRESH_LEAD_SECONDS) await refresh()
    const send = () => api[method](new URL(path, baseUrl).href, {
      ...options,
      headers: { ...(options.headers ?? {}), Authorization: `Bearer ${accessToken}` },
    })
    let response = await send()
    if (response.status() === 401) {
      await refresh()
      response = await send()
    }
    return response
  }

  return { request, dispose: () => api.dispose() }
}

async function loadCheckout(api) {
  const preview = await api.request(
    'get',
    `/api/checkout/preview?productId=${fixture.productId}&offerId=${fixture.offerId}`,
  )
  if (!preview.ok()) throw new Error(`checkout preview failed with HTTP ${preview.status()}`)
  return preview.json()
}

async function createOrder(api, checkout, password) {
  const versions = agreementVersions(checkout.legalRequirement)
  const response = await api.request('post', '/api/orders', {
    data: {
      productId: fixture.productId,
      offerId: fixture.offerId,
      expectedPrice: fixture.expectedPrice,
      verificationPassword: password,
      ...(versions ? { agreementVersions: versions } : {}),
    },
  })
  if (!response.ok()) throw new Error(`order creation failed with HTTP ${response.status()}`)
  const body = await response.json()
  if (!Number.isSafeInteger(body.orderId) || body.orderId <= 0) throw new Error('order response has no valid ID')
  return body.orderId
}

async function injectMerchantSession(page, session) {
  await page.addInitScript(({ user, token }) => {
    window.localStorage.setItem('monexus-auth', JSON.stringify({
      state: { user, accessToken: token, isLoggedIn: true },
      version: 0,
    }))
  }, { user: session.user, token: session.accessToken })
}

async function installStreamProbe(page) {
  await page.addInitScript(() => {
    const target = window
    if (target.__MONEXUS_RT_STAGING_PROBE__) return
    const originalFetch = window.fetch.bind(window)
    const listeners = new Set()
    let text = ''
    const statuses = []
    const contentTypes = []
    let requestCount = 0
    const notify = () => { for (const listener of [...listeners]) listener() }
    const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
      if (predicate()) return resolve()
      const check = () => {
        if (!predicate()) return
        clearTimeout(timer)
        listeners.delete(check)
        resolve()
      }
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error('staging stream probe timeout'))
      }, timeoutMs)
      listeners.add(check)
    })
    target.__MONEXUS_RT_STAGING_PROBE__ = {
      waitReady: (timeoutMs) => waitFor(() => text.includes('stream.ready'), timeoutMs),
      waitStatus: (status, timeoutMs) => waitFor(() => statuses.includes(status), timeoutMs),
      snapshot: () => ({
        requestCount,
        statuses: [...statuses],
        contentTypes: [...contentTypes],
        bodyBytesObserved: text.length,
        readyObserved: text.includes('stream.ready'),
      }),
    }
    window.fetch = (async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url, window.location.origin)
      if (url.pathname !== '/api/notifications/stream') return originalFetch(request)
      requestCount += 1
      const response = await originalFetch(request)
      statuses.push(response.status)
      contentTypes.push(response.headers.get('content-type') ?? '')
      notify()
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
      const [applicationBody, inspectionBody] = response.body.tee()
      void (async () => {
        const reader = inspectionBody.getReader()
        const decoder = new TextDecoder()
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            text = (text + decoder.decode(chunk.value, { stream: true })).slice(-65_536)
            notify()
          }
        } catch {
          // The application owns reconnect semantics; the probe is read-only.
        }
      })()
      return new Response(applicationBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    })
  })
}

async function waitForProbe(page, kind, value, timeoutMs) {
  try {
    await page.evaluate(({ requestedKind, requestedValue, timeout }) => {
      const probe = window.__MONEXUS_RT_STAGING_PROBE__
      if (!probe) throw new Error('staging stream probe missing')
      return requestedKind === 'ready'
        ? probe.waitReady(timeout)
        : probe.waitStatus(requestedValue, timeout)
    }, { requestedKind: kind, requestedValue: value, timeout: timeoutMs })
  } catch (error) {
    const snapshot = await page.evaluate(() => (
      window.__MONEXUS_RT_STAGING_PROBE__?.snapshot?.() ?? null
    )).catch(() => null)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; stream_probe=${JSON.stringify(snapshot)}`)
  }
}

async function openMerchantOrders(page, expectedStream, session) {
  await installStreamProbe(page)
  await injectMerchantSession(page, session)
  // The orders tab and its DOM probe belong to the main merchant workbench;
  // /merchant/dashboard is the separate analytics page and has no order tab.
  await page.goto(new URL('/merchant', baseUrl).href, { waitUntil: 'domcontentloaded' })
  if (expectedStream === 'ready') await waitForProbe(page, 'ready', null, 15_000)
  else await waitForProbe(page, 'status', 404, 15_000)
  await page.getByRole('button', { name: '订单管理', exact: true }).click()
  await page.getByTestId('merchant-order-todo').waitFor({ state: 'visible', timeout: 15_000 })
}

function orderLocator(page, orderId) {
  return page.locator('td[data-label="订单号"] div').filter({
    hasText: new RegExp(`^\\s*${orderId}\\s*$`),
  })
}

async function runToken(password) {
  const tokenPath = process.env.RT_STAGING_TOKEN_FILE ?? ''
  if (!tokenPath) throw new Error('workflow-private token path is required')
  const api = await playwright.request.newContext({ timeout: 15_000 })
  try {
    const session = await loginAccount(api, fixture.merchant, password)
    writePrivateFile(tokenPath, `${session.accessToken}\n`)
  } finally {
    await api.dispose()
  }
  console.log('[PASS] fresh staging merchant token written to workflow-private file')
}

async function runLatency(password) {
  const sampleCount = Number.parseInt(process.env.RT_STAGING_SAMPLE_COUNT ?? '100', 10)
  if (sampleCount !== 100) throw new Error('release latency evidence requires exactly 100 samples')
  const evidencePath = process.env.RT_STAGING_LATENCY_EVIDENCE_FILE ?? ''
  if (!evidencePath) throw new Error('latency evidence path is required')
  let browser
  let context
  let buyerApi
  const latencies = []
  const startedAt = Date.now()
  let lastOrderId = null
  let failureCount = 0
  let failedSample = 0
  let failureStage = 'browser_start'
  let failureMessage = ''
  let caught = null

  try {
    browser = await playwright.chromium.launch({ headless: true })
    context = await browser.newContext({ baseURL: baseUrl.href })
    const page = await context.newPage()
    failureStage = 'merchant_login'
    // BrowserContext.request shares the browser cookie jar. loginAccount also
    // asserts the HttpOnly refresh cookie, so the mounted application—not the
    // collector—refreshes the merchant stream when auth.expiring arrives.
    const merchantSession = await loginAccount(context.request, fixture.merchant, password)
    failureStage = 'buyer_login'
    buyerApi = await createAuthenticatedApi(fixture.buyer, password)
    failureStage = 'checkout_preview'
    const checkout = await loadCheckout(buyerApi)
    failureStage = 'stream_ready'
    await openMerchantOrders(page, 'ready', merchantSession)
    for (let index = 0; index < sampleCount; index += 1) {
      failureStage = 'order_api'
      let orderId
      try {
        orderId = await createOrder(buyerApi, checkout, password)
      } catch (error) {
        failedSample = index + 1
        throw error
      }
      const apiCompletedAt = performance.now()
      failureStage = 'merchant_dom'
      try {
        await orderLocator(page, orderId).waitFor({ state: 'visible', timeout: NORMAL_LIMIT_MS })
      } catch {
        failureCount += 1
        failedSample = index + 1
        throw new Error('merchant DOM sample timed out')
      }
      latencies.push(Math.ceil(performance.now() - apiCompletedAt))
      lastOrderId = orderId
      if ((index + 1) % 10 === 0) console.log(`[staging] samples_completed=${index + 1}/${sampleCount}`)
    }
    failureStage = 'complete'
  } catch (error) {
    caught = error
    failureMessage = error instanceof Error ? error.message : String(error)
    if (failureCount === 0) failureCount = 1
  } finally {
    await Promise.allSettled([
      buyerApi?.dispose(),
      context?.close(),
      browser?.close(),
    ].filter(Boolean))
  }

  const metric = (percentile) => latencies.length > 0
    ? Math.ceil(nearestRank(latencies, percentile))
    : 'NA'
  const p50 = metric(0.50)
  const p95 = metric(0.95)
  const p99 = metric(0.99)
  const maximum = latencies.length > 0 ? Math.max(...latencies) : 'NA'
  const passed = !caught
    && latencies.length === sampleCount
    && failureCount === 0
    && p95 <= 2_000
    && p99 <= 5_000
  const evidenceContents = [
    `result=${passed ? 'PASS' : 'FAIL'}`,
    `head=${head}`,
    'environment=staging',
    `collected_at=${new Date().toISOString()}`,
    `sample_count=${latencies.length}`,
    `failure_count=${failureCount}`,
    `failure_stage=${passed ? 'none' : failureStage}`,
    `failed_sample=${failedSample}`,
    `failure_message=${(passed ? '' : failureMessage).replace(/[\r\n=]/g, ' ').slice(0, 240)}`,
    `p50_ms=${p50}`,
    `p95_ms=${p95}`,
    `p99_ms=${p99}`,
    `max_ms=${maximum}`,
    `duration_ms=${Date.now() - startedAt}`,
    'start=order_api_2xx',
    'target=merchant_order_id_dom',
    '',
  ].join('\n')
  try {
    writePrivateFile(evidencePath, evidenceContents)
  } catch {
    // The artifact filesystem itself may be unavailable. Preserve a
    // credential-free structured fallback in the protected workflow log.
    console.error(`[FAIL_EVIDENCE] result=FAIL head=${head} sample_count=${latencies.length} failure_stage=evidence_write original_stage=${failureStage}`)
    throw new Error('staging latency evidence file could not be written')
  }

  if (!passed) {
    console.error(`[FAIL] staging latency collection stopped at ${failureStage}; ${failureMessage || 'no error message'}; aggregate FAIL evidence was written`)
    throw new Error('staging latency thresholds or sample completion requirements were not met')
  }
  saveState({ lastOrderId, latencySamples: latencies.length })
  console.log(`[PASS] staging latency samples=${latencies.length} p50_ms=${p50} p95_ms=${p95} p99_ms=${p99}`)
}

async function runFallback(password) {
  const browser = await playwright.chromium.launch({ headless: true })
  const context = await browser.newContext({ baseURL: baseUrl.href })
  const page = await context.newPage()
  const buyerApi = await createAuthenticatedApi(fixture.buyer, password)
  try {
    const state = loadState()
    if (!Number.isSafeInteger(state.lastOrderId)) throw new Error('latency history state is missing')
    const merchantSession = await loginAccount(context.request, fixture.merchant, password)
    const checkout = await loadCheckout(buyerApi)
    await openMerchantOrders(page, 'off', merchantSession)
    await orderLocator(page, state.lastOrderId).waitFor({ state: 'visible', timeout: 15_000 })
    const orderId = await createOrder(buyerApi, checkout, password)
    const apiCompletedAt = performance.now()
    await orderLocator(page, orderId).waitFor({ state: 'visible', timeout: FALLBACK_LIMIT_MS })
    const elapsedMs = Math.ceil(performance.now() - apiCompletedAt)
    if (elapsedMs > FALLBACK_LIMIT_MS) throw new Error('fallback exceeded the frozen 35 second limit')
    saveState({ ...state, lastOrderId: orderId, fallbackElapsedMs: elapsedMs })
    console.log(`[PASS] staging flag-off fallback elapsed_ms=${elapsedMs}`)
  } finally {
    await Promise.allSettled([buyerApi.dispose(), context.close(), browser.close()])
  }
}

async function runHistory(password) {
  const state = loadState()
  if (!Number.isSafeInteger(state.lastOrderId)) throw new Error('rollback history state is missing')
  const api = await createAuthenticatedApi(fixture.merchant, password)
  try {
    const response = await api.request('get', '/api/merchant/orders?page=1&pageSize=20')
    if (!response.ok()) throw new Error(`post-rollback history request failed with HTTP ${response.status()}`)
    const body = await response.json()
    const items = Array.isArray(body) ? body : body.items
    if (!Array.isArray(items) || !items.some((order) => order.id === state.lastOrderId)) {
      throw new Error('post-rollback history did not contain the canary order')
    }
    console.log('[PASS] staging post-code-rollback REST history retained')
  } finally {
    await api.dispose()
  }
}

const password = readPassword()
if (mode === 'token') await runToken(password)
else if (mode === 'latency') await runLatency(password)
else if (mode === 'fallback') await runFallback(password)
else await runHistory(password)
