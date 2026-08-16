// @ts-check
/**
 * Tests for scripts/cmi/xboard-fixture-server.mjs (Xboard local catalog
 * fixture server narrow card). Runs against a factory instance started on a
 * dynamic (OS-assigned) port with an isolated test secret.
 *
 * Run: node --test scripts/cmi/xboard-fixture-server.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createFixtureServer, MAX_FIXTURE_BODY_BYTES } from './xboard-fixture-server.mjs'

const TEST_SECRET = 'unit-test-fixture-secret'

/** Independent implementation of the server-side `/plan-catalog` signing contract. */
function signPaidAt(paidAt, secret) {
  return createHmac('sha256', secret).update(`paid_at=${paidAt}`, 'utf8').digest('hex')
}

/**
 * Independent implementation of the `/plan-capacity` signing contract (do not
 * import the production sign). Payload is the lexicographic-canonical
 * `paid_at=<unix>&sku=<sku>`; sku is normalized trim+lowercase like the
 * production client.
 */
function signPlanCapacity(sku, paidAt, secret) {
  const skuNorm = sku.trim().toLowerCase()
  return createHmac('sha256', secret)
    .update(`paid_at=${paidAt}&sku=${skuNorm}`, 'utf8')
    .digest('hex')
}

function parseJson(text) {
  return JSON.parse(text)
}

/**
 * Minimal fetch wrapper that asserts every response is JSON + Cache-Control
 * no-store (requirement: all responses no-store/json).
 * @param {string} baseUrl
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(baseUrl, path, init) {
  const res = await fetch(new URL(path, baseUrl), init)
  assert.ok(
    (res.headers.get('cache-control') ?? '').includes('no-store'),
    `expected Cache-Control no-store on ${path}, got ${res.headers.get('cache-control')}`
  )
  const contentType = res.headers.get('content-type') ?? ''
  assert.ok(
    contentType.includes('application/json'),
    `expected application/json on ${path}, got ${contentType}`
  )
  const text = await res.text()
  return { status: res.status, body: parseJson(text), rawText: text, headers: res.headers }
}

/** Signed plan-catalog GET (returns full request result). */
function planCatalog(baseUrl, { paidAt, sign, accept }) {
  const headers = {}
  if (accept !== undefined) headers.Accept = accept
  return request(baseUrl, `/plan-catalog?paid_at=${paidAt}&sign=${sign}`, { headers })
}

/** Signed plan-capacity GET (returns full request result). */
function planCapacity(baseUrl, { sku, paidAt, sign, accept }) {
  const headers = {}
  if (accept !== undefined) headers.Accept = accept
  return request(baseUrl, `/plan-capacity?sku=${encodeURIComponent(sku)}&paid_at=${paidAt}&sign=${sign}`, {
    headers,
  })
}

/**
 * @param {ReturnType<typeof createFixtureServer>} fixture
 * @param {() => Promise<void>} fn
 */
async function withFixture(fixture, fn) {
  const port = await fixture.start()
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'dynamic port in range')
  assert.ok(fixture.baseUrl !== null && fixture.baseUrl.includes(String(port)))
  try {
    await fn(fixture)
  } finally {
    await fixture.stop()
  }
}

function freshFixture() {
  return createFixtureServer({ host: '127.0.0.1', port: 0, secret: TEST_SECRET })
}

/** @param {{ rawText: string, status: number }} res */
function assertNoSecretLeak(res) {
  assert.ok(!res.rawText.includes(TEST_SECRET), 'response must not echo the secret')
}

function goldPlan(plans) {
  const gold = plans.find(plan => plan.plan_id === 77)
  assert.ok(gold, 'plan_id 77 present')
  return gold
}

test('health: ready JSON, strictly no sensitive info', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const res = await request(fixture.baseUrl, '/health')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { success: true, status: 'ready', ready: true })
    assertNoSecretLeak(res)
    assert.ok(!res.rawText.includes('127.0.0.1'))
  })
})

test('baseline: valid signature returns complete plan catalog shape', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const sign = signPaidAt(paidAt, TEST_SECRET)
    const res = await planCatalog(fixture.baseUrl, {
      paidAt,
      sign,
      accept: 'application/json',
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.ok(Array.isArray(res.body.plans) && res.body.plans.length >= 2)
    // External Xboard contract: top-level keys are exactly success/plans
    // (no fixture-internal sourceHash on the provider response).
    assert.deepEqual(Object.keys(res.body).sort(), ['plans', 'success'])

    const gold = goldPlan(res.body.plans)
    assert.equal(gold.name, 'Gold Plan')
    assert.equal(gold.show, true)
    assert.equal(gold.sell, true)
    assert.equal(gold.renew, true)
    assert.equal(typeof gold.group_id, 'number')
    assert.ok(Number.isFinite(gold.transfer_enable) && gold.transfer_enable > 0)
    assert.equal(typeof gold.capacity_limit, 'number')
    assert.equal(typeof gold.active_users, 'number')
    assert.equal(typeof gold.remaining, 'number')

    // hostile content for the business sanitizer E2E: safe body + script + remote img onerror
    assert.ok(gold.content.includes('Gold Plan'), 'content has safe body text')
    assert.ok(gold.content.includes('<script>'), 'content has script tag')
    assert.ok(gold.content.includes('<img'), 'content has img tag')
    assert.ok(gold.content.includes('onerror'), 'content has onerror handler')
    assert.ok(gold.content.includes('http'), 'content references a remote URL')

    // periods monthly + yearly, each with price + sku_alias
    const periods = gold.periods
    assert.ok(Array.isArray(periods) && periods.length >= 2)
    for (const period of periods) {
      assert.equal(typeof period.period, 'string')
      assert.equal(typeof period.price, 'number')
      assert.equal(typeof period.sku_alias, 'string')
    }
    const monthly = periods.find(p => p.period === 'monthly')
    const yearly = periods.find(p => p.period === 'yearly')
    assert.ok(monthly && yearly)
    assert.equal(monthly.sku_alias, 'gold-monthly')
    assert.equal(yearly.sku_alias, 'gold-yearly')

    // named_skus complete
    assert.ok(Array.isArray(gold.named_skus) && gold.named_skus.length >= 2)
    for (const named of gold.named_skus) {
      assert.equal(typeof named.sku, 'string')
      assert.equal(typeof named.period, 'string')
    }

    assertNoSecretLeak(res)
  })
})

test('plan-catalog: wrong sign / missing sign / extra query / bad formats rejected 400 without echoing secret', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const validSign = signPaidAt(paidAt, TEST_SECRET)

    /** @type {Array<[string, number]>} */
    const bad = [
      // wrong signature
      [`/plan-catalog?paid_at=${paidAt}&sign=${'0'.repeat(64)}`, 400],
      // missing sign
      [`/plan-catalog?paid_at=${paidAt}`, 400],
      // missing paid_at
      [`/plan-catalog?sign=${validSign}`, 400],
      // extra query parameter
      [`/plan-catalog?paid_at=${paidAt}&sign=${validSign}&foo=bar`, 400],
      // bad paid_at format (not unix seconds)
      [`/plan-catalog?paid_at=not-a-date&sign=${validSign}`, 400],
      // paid_at negative / float
      [`/plan-catalog?paid_at=-1&sign=${validSign}`, 400],
      [`/plan-catalog?paid_at=123.5&sign=${validSign}`, 400],
      // paid_at out of reasonable range
      [`/plan-catalog?paid_at=99999999999&sign=${validSign}`, 400],
      // bad sign format (uppercase hex / wrong length)
      [`/plan-catalog?paid_at=${paidAt}&sign=${'A'.repeat(64)}`, 400],
      [`/plan-catalog?paid_at=${paidAt}&sign=${'a'.repeat(63)}`, 400],
    ]

    for (const [path, expectedStatus] of bad) {
      const res = await request(fixture.baseUrl, path)
      assert.equal(res.status, expectedStatus, `expected ${expectedStatus} for ${path}`)
      assert.equal(res.body.success, false)
      assert.equal(typeof res.body.error, 'string')
      assertNoSecretLeak(res)
      assert.ok(!res.rawText.includes('Error'), 'no stack/error object leaked')
    }
  })
})

test('plan-catalog: unsupported Accept rejected with 400 (still JSON + no-store)', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const sign = signPaidAt(paidAt, TEST_SECRET)
    const res = await planCatalog(fixture.baseUrl, {
      paidAt,
      sign,
      accept: 'text/html',
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.success, false)
    assertNoSecretLeak(res)
  })
})

test('mutate-source changes catalog name/content/price; reset restores baseline (control-endpoint sourceHash)', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const sign = signPaidAt(paidAt, TEST_SECRET)

    // Baseline state + source hash come from the fixture control endpoint —
    // the provider /plan-catalog contract never carries sourceHash.
    const baselineControl = await request(fixture.baseUrl, '/__fixture/reset', { method: 'POST' })
    assert.equal(baselineControl.status, 200)
    const baselineHash = baselineControl.body.sourceHash
    assert.match(baselineHash, /^[0-9a-f]{64}$/)

    const baseline = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(baseline.status, 200)
    assert.deepEqual(Object.keys(baseline.body).sort(), ['plans', 'success'])
    assert.equal(goldPlan(baseline.body.plans).name, 'Gold Plan')
    const baselineYearly = goldPlan(baseline.body.plans).periods.find(p => p.period === 'yearly')
    assert.equal(baselineYearly.price, 30000)

    const mutated = await request(fixture.baseUrl, '/__fixture/mutate-source', {
      method: 'POST',
    })
    assert.equal(mutated.status, 200)
    assert.equal(mutated.body.action, 'mutate-source')
    assert.match(mutated.body.sourceHash, /^[0-9a-f]{64}$/)
    assert.notEqual(mutated.body.sourceHash, baselineHash, 'sourceHash changed after mutate')

    const afterMutate = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(afterMutate.status, 200)
    assert.deepEqual(Object.keys(afterMutate.body).sort(), ['plans', 'success'])
    assert.equal(goldPlan(afterMutate.body.plans).name, 'Gold Plan (mutated)')
    const mutatedYearly = goldPlan(afterMutate.body.plans).periods.find(p => p.period === 'yearly')
    assert.equal(mutatedYearly.price, 33000)
    assert.ok(goldPlan(afterMutate.body.plans).content.includes('mutate-source'))
    assertNoSecretLeak(mutated)
    assertNoSecretLeak(afterMutate)

    const reset = await request(fixture.baseUrl, '/__fixture/reset', { method: 'POST' })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.action, 'reset')
    assert.equal(reset.body.sourceHash, baselineHash, 'reset restores baseline sourceHash')

    const afterReset = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(afterReset.status, 200)
    assert.equal(goldPlan(afterReset.body.plans).name, 'Gold Plan')
    const resetYearly = goldPlan(afterReset.body.plans).periods.find(p => p.period === 'yearly')
    assert.equal(resetYearly.price, 30000)
  })
})

test('fail-catalog: one-shot 503 then auto-recover; persistent 503 until reset', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const sign = signPaidAt(paidAt, TEST_SECRET)

    // one-shot (default / persistent:false)
    const armed = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persistent: false }),
    })
    assert.equal(armed.status, 200)
    assert.equal(armed.body.mode, 'once')

    const failedOnce = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(failedOnce.status, 503)
    assert.deepEqual(failedOnce.body, { success: false, error: 'fixture catalog unavailable' })
    assertNoSecretLeak(failedOnce)

    const recovered = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(recovered.status, 200, 'one-shot failure auto-recovers')

    // persistent until reset
    const armedPersistent = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persistent: true }),
    })
    assert.equal(armedPersistent.status, 200)
    assert.equal(armedPersistent.body.mode, 'persistent')

    const fail1 = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(fail1.status, 503)
    const fail2 = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(fail2.status, 503, 'persistent failure keeps failing')

    const reset = await request(fixture.baseUrl, '/__fixture/reset', { method: 'POST' })
    assert.equal(reset.status, 200)

    const recoveredAfterReset = await planCatalog(fixture.baseUrl, { paidAt, sign })
    assert.equal(recoveredAfterReset.status, 200, 'reset clears persistent failure')
  })
})

test('fail-catalog: JSON body strict allowlist + body size limit', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    // unknown body key rejected
    const unknown = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persistent: true, nope: 1 }),
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.success, false)

    // non-boolean persistent rejected
    const nonBool = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persistent: 'yes' }),
    })
    assert.equal(nonBool.status, 400)

    // invalid JSON rejected
    const invalid = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    })
    assert.equal(invalid.status, 400)

    // non-JSON content type rejected (body present)
    const wrongType = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'persistent',
    })
    assert.equal(wrongType.status, 400)

    // body size limit → 413
    const oversized = await request(fixture.baseUrl, '/__fixture/fail-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persistent: true, padding: 'x'.repeat(MAX_FIXTURE_BODY_BYTES) }),
    })
    assert.equal(oversized.status, 413)

    for (const res of [unknown, nonBool, invalid, wrongType, oversized]) {
      assert.equal(typeof res.body.error, 'string')
      assertNoSecretLeak(res)
    }
  })
})

test('plan-capacity: gold aliases return the exact capacity snapshot with exact keys', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))

    const goldMonthly = await planCapacity(fixture.baseUrl, {
      sku: 'gold-monthly',
      paidAt,
      sign: signPlanCapacity('gold-monthly', paidAt, TEST_SECRET),
      accept: 'application/json',
    })
    assert.equal(goldMonthly.status, 200)
    assert.deepEqual(goldMonthly.body, {
      success: true,
      sku: 'gold-monthly',
      plan_id: 77,
      period: 'monthly',
      capacity_limit: 200,
      active_users: 12,
      remaining: 188,
      sellable: true,
      show: true,
      sell: true,
    })
    assert.deepEqual(Object.keys(goldMonthly.body), [
      'success',
      'sku',
      'plan_id',
      'period',
      'capacity_limit',
      'active_users',
      'remaining',
      'sellable',
      'show',
      'sell',
    ])
    assertNoSecretLeak(goldMonthly)

    const goldYearly = await planCapacity(fixture.baseUrl, {
      sku: 'gold-yearly',
      paidAt,
      sign: signPlanCapacity('gold-yearly', paidAt, TEST_SECRET),
      accept: 'application/json',
    })
    assert.equal(goldYearly.status, 200)
    assert.deepEqual(goldYearly.body, {
      success: true,
      sku: 'gold-yearly',
      plan_id: 77,
      period: 'yearly',
      capacity_limit: 200,
      active_users: 12,
      remaining: 188,
      sellable: true,
      show: true,
      sell: true,
    })
    assertNoSecretLeak(goldYearly)
  })
})

test('plan-capacity: basic aliases map to plan 1 with null capacity/remaining and active 0', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    for (const [sku, period] of [
      ['basic-monthly', 'monthly'],
      ['basic-yearly', 'yearly'],
    ]) {
      const res = await planCapacity(fixture.baseUrl, {
        sku,
        paidAt,
        sign: signPlanCapacity(sku, paidAt, TEST_SECRET),
        accept: 'application/json',
      })
      assert.equal(res.status, 200, `${sku} resolves`)
      assert.deepEqual(res.body, {
        success: true,
        sku,
        plan_id: 1,
        period,
        capacity_limit: null,
        active_users: 0,
        remaining: null,
        sellable: true,
        show: true,
        sell: true,
      })
      assertNoSecretLeak(res)
    }
  })
})

test('plan-capacity: wrong/missing/uppercase sign, extra/duplicate query, bad sku/paid_at rejected 400 without leaking', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const validSign = signPlanCapacity('gold-monthly', paidAt, TEST_SECRET)

    /** @type {Array<[string, number]>} */
    const bad = [
      // wrong sign / missing sign / uppercase hex
      [`/plan-capacity?sku=gold-monthly&paid_at=${paidAt}&sign=${'0'.repeat(64)}`, 400],
      [`/plan-capacity?sku=gold-monthly&paid_at=${paidAt}`, 400],
      [`/plan-capacity?sku=gold-monthly&paid_at=${paidAt}&sign=${'A'.repeat(64)}`, 400],
      [`/plan-capacity?sku=gold-monthly&paid_at=${paidAt}&sign=${'a'.repeat(63)}`, 400],
      // extra query parameter / duplicate keys
      [`/plan-capacity?sku=gold-monthly&paid_at=${paidAt}&sign=${validSign}&foo=bar`, 400],
      [`/plan-capacity?sku=gold-monthly&sku=gold-monthly&paid_at=${paidAt}&sign=${validSign}`, 400],
      [`/plan-capacity?sku=gold-monthly&paid_at=${paidAt}&paid_at=${paidAt}&sign=${validSign}`, 400],
      // missing required key
      [`/plan-capacity?paid_at=${paidAt}&sign=${validSign}`, 400],
      [`/plan-capacity?sku=gold-monthly&sign=${validSign}`, 400],
      // bad sku: empty / invalid chars / too long
      [`/plan-capacity?sku=&paid_at=${paidAt}&sign=${validSign}`, 400],
      [`/plan-capacity?sku=gold/monthly&paid_at=${paidAt}&sign=${validSign}`, 400],
      [`/plan-capacity?sku=bad%20sku&paid_at=${paidAt}&sign=${validSign}`, 400],
      [`/plan-capacity?sku=${'a'.repeat(65)}&paid_at=${paidAt}&sign=${validSign}`, 400],
      // bad paid_at
      [`/plan-capacity?sku=gold-monthly&paid_at=not-a-date&sign=${validSign}`, 400],
      [`/plan-capacity?sku=gold-monthly&paid_at=-1&sign=${validSign}`, 400],
      [`/plan-capacity?sku=gold-monthly&paid_at=99999999999&sign=${validSign}`, 400],
    ]

    for (const [path, expectedStatus] of bad) {
      const res = await request(fixture.baseUrl, path)
      assert.equal(res.status, expectedStatus, `expected ${expectedStatus} for ${path}`)
      assert.equal(res.body.success, false)
      assert.equal(typeof res.body.error, 'string')
      assertNoSecretLeak(res)
      assert.ok(!res.rawText.includes('Error'), 'no stack/error object leaked')
    }
  })
})

test('plan-capacity: sku is normalized (trim+lowercase) before signing and lookup', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    // Sign the normalized value exactly as the production client would.
    const res = await planCapacity(fixture.baseUrl, {
      sku: ' GOLD-MONTHLY ',
      paidAt,
      sign: signPlanCapacity(' GOLD-MONTHLY ', paidAt, TEST_SECRET),
      accept: 'application/json',
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.sku, 'gold-monthly')
    assert.equal(res.body.plan_id, 77)
    assert.equal(res.body.period, 'monthly')
    assertNoSecretLeak(res)
  })
})

test('plan-capacity: unknown sku returns 404 with no catalog content / secret leak', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const unknown = 'no-such-sku'
    const res = await planCapacity(fixture.baseUrl, {
      sku: unknown,
      paidAt,
      sign: signPlanCapacity(unknown, paidAt, TEST_SECRET),
      accept: 'application/json',
    })
    assert.equal(res.status, 404)
    assert.deepEqual(res.body, { success: false, error: 'sku not found' })
    assertNoSecretLeak(res)
    assert.ok(!res.rawText.includes('Gold Plan'), 'no catalog content leaked')
    assert.ok(!res.rawText.includes('gold-monthly'), 'no sku aliases leaked')
    assert.ok(!res.rawText.includes('capacity_limit'), 'no catalog fields leaked')
  })
})

test('plan-capacity: unsupported Accept rejected with 400 (still JSON + no-store)', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const res = await planCapacity(fixture.baseUrl, {
      sku: 'gold-monthly',
      paidAt,
      sign: signPlanCapacity('gold-monthly', paidAt, TEST_SECRET),
      accept: 'text/html',
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.success, false)
    assertNoSecretLeak(res)
  })
})

test('plan-capacity: mutate-source flips gold-yearly alias; reset restores baseline', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const paidAt = String(Math.floor(Date.now() / 1000))
    const goldYearly = () =>
      planCapacity(fixture.baseUrl, {
        sku: 'gold-yearly',
        paidAt,
        sign: signPlanCapacity('gold-yearly', paidAt, TEST_SECRET),
      })
    const goldYearlyV2 = () =>
      planCapacity(fixture.baseUrl, {
        sku: 'gold-yearly-v2',
        paidAt,
        sign: signPlanCapacity('gold-yearly-v2', paidAt, TEST_SECRET),
      })

    // baseline: gold-yearly present, v2 absent
    assert.equal((await goldYearly()).status, 200)
    assert.equal((await goldYearlyV2()).status, 404)

    const mutated = await request(fixture.baseUrl, '/__fixture/mutate-source', { method: 'POST' })
    assert.equal(mutated.status, 200)
    assertNoSecretLeak(mutated)

    // after mutate: v2 resolves (period yearly, plan 77), old alias 404s
    const v2 = await goldYearlyV2()
    assert.equal(v2.status, 200)
    assert.deepEqual(v2.body, {
      success: true,
      sku: 'gold-yearly-v2',
      plan_id: 77,
      period: 'yearly',
      capacity_limit: 200,
      active_users: 12,
      remaining: 188,
      sellable: true,
      show: true,
      sell: true,
    })
    const stale = await goldYearly()
    assert.equal(stale.status, 404)
    assert.deepEqual(stale.body, { success: false, error: 'sku not found' })
    assertNoSecretLeak(v2)
    assertNoSecretLeak(stale)

    const reset = await request(fixture.baseUrl, '/__fixture/reset', { method: 'POST' })
    assert.equal(reset.status, 200)

    // reset restores: gold-yearly back, v2 gone
    assert.equal((await goldYearly()).status, 200)
    assert.equal((await goldYearlyV2()).status, 404)
  })
})

test('plan-capacity: non-GET methods get 405 with Allow: GET (still JSON + no-store)', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await request(fixture.baseUrl, '/plan-capacity', { method })
      assert.equal(res.status, 405, `${method} /plan-capacity`)
      assert.equal(res.headers.get('allow'), 'GET')
      assert.equal(res.body.success, false)
      assertNoSecretLeak(res)
    }
  })
})

test('404 / 405 for unknown paths and wrong methods', async () => {
  const fixture = await freshFixture()
  await withFixture(fixture, async () => {
    const notFound = await request(fixture.baseUrl, '/does-not-exist')
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body.success, false)

    const postHealth = await request(fixture.baseUrl, '/health', { method: 'POST' })
    assert.equal(postHealth.status, 405)

    const postCatalog = await request(fixture.baseUrl, '/plan-catalog', { method: 'POST' })
    assert.equal(postCatalog.status, 405)

    const getReset = await request(fixture.baseUrl, '/__fixture/reset')
    assert.equal(getReset.status, 405)

    const unknownFixture = await request(fixture.baseUrl, '/__fixture/nope', { method: 'POST' })
    assert.equal(unknownFixture.status, 404)

    for (const res of [notFound, postHealth, postCatalog, getReset, unknownFixture]) {
      assert.equal(res.body.success, false)
      assertNoSecretLeak(res)
    }
  })
})

test('fixture factory: default host/secret and dynamic port; stop releases the port', async () => {
  const fixture = await freshFixture()
  const port1 = await fixture.start()
  assert.equal(fixture.host, '127.0.0.1')
  assert.equal(fixture.secret, TEST_SECRET)
  await fixture.stop()

  // start/stop again on a fresh (possibly same) dynamic port to prove reusability
  const port2 = await fixture.start()
  assert.ok(Number.isInteger(port2) && port2 > 0)
  const health = await request(fixture.baseUrl, '/health')
  assert.equal(health.status, 200)
  await fixture.stop()

  assert.ok(port1 > 0 && port2 > 0)
})
