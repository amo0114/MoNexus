import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestCnyValuePolicy,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
} from './helpers.js'

const originalMode = config.pointValuePolicyMode

function setMode(mode: typeof config.pointValuePolicyMode) {
  config.pointValuePolicyMode = mode
}

afterEach(async () => {
  config.pointValuePolicyMode = originalMode
  await prisma.assetDefinition.updateMany({
    where: { code: { in: ['RP', 'CNY'] } },
    data: { enabled: true, retiredAt: null },
  }).catch(() => {})
})

describe('GET /api/value-policy/current', () => {
  it('returns 404 VALUE_POLICY_DISABLED in off mode', async () => {
    setMode('off')
    const res = await api.get('/api/value-policy/current').expect(404)
    expect(res.body.error.code).toBe('VALUE_POLICY_DISABLED')
  })

  it('does not leak a draft policy', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_draft_hidden', version: 1, status: 'draft' })
    const res = await api.get('/api/value-policy/current').expect(503)
    expect(res.body.error.code).toBe('VALUE_POLICY_UNAVAILABLE')
  })

  it('returns the active CNY policy with string atomic fields', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1, status: 'active' })
    const res = await api.get('/api/value-policy/current').expect(200)
    expect(res.body).toMatchObject({
      id: 'vp_cny_001',
      version: 1,
      pointAsset: { code: 'RP', scale: 0 },
      referenceAsset: { code: 'CNY', scale: 2 },
      ratio: {
        referenceAtomicPerPointNumerator: '1',
        referenceAtomicPerPointDenominator: '1',
      },
      roundingMode: 'HALF_EVEN',
    })
    expect(typeof res.body.ratio.referenceAtomicPerPointNumerator).toBe('string')
    expect(res.body.disclosure).toContain('参考价值')
    expect(JSON.stringify(res.body)).not.toContain('"1n"')
  })
})

describe('checkout preview and order pricing', () => {
  it('keeps the legacy preview contract in off mode and writes no snapshot', async () => {
    setMode('off')
    await createTestUser('vp-off@test.local', 'pass123', 'user', 2000)
    await createTestProduct('off商品', 1200, 2, ['off-1', 'off-2'])
    const { accessToken } = await loginAs('vp-off@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(preview.body.price).toBe(1200)
    expect(preview.body.pricing).toBeUndefined()

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 1200, expectedValuePolicyId: 'vp_ignored' })
      .expect(201)
    expect(created.body.price).toBe(1200)
    expect(created.body.pricing).toBeUndefined()
    expect(await prisma.orderPricingSnapshot.count()).toBe(0)
  })

  it('returns string atomic pricing on preview in shadow mode', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-preview@test.local', 'pass123', 'user', 2000)
    await createTestProduct('定价商品', 1200, 1, ['p-1'])
    const { accessToken } = await loginAs('vp-preview@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(preview.body.price).toBe(1200)
    expect(preview.body.pricing).toEqual({
      points: { assetCode: 'RP', amountAtomic: '1200', scale: 0 },
      reference: { assetCode: 'CNY', amountAtomic: '1200', scale: 2 },
      valuePolicyId: 'vp_cny_001',
    })
    expect(typeof preview.body.pricing.reference.amountAtomic).toBe('string')
  })

  it('lets a shadow-mode legacy client omit the policy id', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-shadow-old@test.local', 'pass123', 'user', 2000)
    await createTestProduct('兼容商品', 300, 1, ['s-1'])
    const { accessToken } = await loginAs('vp-shadow-old@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 300 })
      .expect(201)
    expect(created.body.pricing).toEqual({
      points: { assetCode: 'RP', amountAtomic: '300', scale: 0 },
      reference: { assetCode: 'CNY', amountAtomic: '300', scale: 2 },
      valuePolicyId: 'vp_cny_001',
    })
    expect(await prisma.orderPricingSnapshot.count()).toBe(1)
  })

  it('requires expectedValuePolicyId in enforce mode', async () => {
    setMode('enforce')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-enforce@test.local', 'pass123', 'user', 2000)
    await createTestProduct('强制商品', 300, 1, ['e-1'])
    const { accessToken } = await loginAs('vp-enforce@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 300 })
      .expect(400)
    expect(res.body.error.code).toBe('VALUE_POLICY_REQUIRED')
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.orderPricingSnapshot.count()).toBe(0)
  })

  it('rejects a stale policy before any funds or inventory side effects', async () => {
    setMode('enforce')
    const { merchant } = await createTestMerchant('vp-stale-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    await createTestCnyValuePolicy({ id: 'vp_old', version: 1 })
    const { user } = await createTestUser('vp-stale@test.local', 'pass123', 'user', 2000)
    await createTestProduct('变更商品', 400, 2, ['stale-1', 'stale-2'], merchant.id)
    const { accessToken } = await loginAs('vp-stale@test.local', 'pass123')

    await prisma.valuePolicy.update({
      where: { id: 'vp_old' },
      data: { status: 'retired', retiredAt: new Date() },
    })
    await createTestCnyValuePolicy({ id: 'vp_new', version: 2 })

    const beforeAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    const beforeInventory = await prisma.inventoryItem.count({ where: { status: 'available' } })

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 400, expectedValuePolicyId: 'vp_old' })
      .expect(409)
    expect(res.body.error.code).toBe('VALUE_POLICY_CHANGED')

    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.pointLog.count({ where: { type: { in: ['out', 'hold'] } } })).toBe(0)
    expect(await prisma.settlement.count()).toBe(0)
    expect(await prisma.inventoryLog.count()).toBe(0)
    expect(await prisma.orderPricingSnapshot.count()).toBe(0)
    const afterAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(afterAccount.balance).toBe(beforeAccount.balance)
    expect(afterAccount.frozenBalance).toBe(beforeAccount.frozenBalance)
    expect(await prisma.inventoryItem.count({ where: { status: 'available' } })).toBe(beforeInventory)
  })

  it('persists one immutable snapshot and keeps it after the policy is replaced', async () => {
    setMode('enforce')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-snap@test.local', 'pass123', 'user', 2000)
    await createTestProduct('快照商品', 1200, 1, ['snap-1'])
    const { accessToken } = await loginAs('vp-snap@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 1200, expectedValuePolicyId: 'vp_cny_001' })
      .expect(201)
    expect(created.body.pricing.reference.amountAtomic).toBe('1200')
    expect(await prisma.orderPricingSnapshot.count()).toBe(1)

    await prisma.valuePolicy.update({
      where: { id: 'vp_cny_001' },
      data: { status: 'retired', retiredAt: new Date() },
    })
    await createTestCnyValuePolicy({
      id: 'vp_cny_002',
      version: 2,
      numerator: 2n,
      denominator: 1n,
    })

    const detail = await api
      .get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.pricing).toEqual({
      points: { assetCode: 'RP', amountAtomic: '1200', scale: 0 },
      reference: { assetCode: 'CNY', amountAtomic: '1200', scale: 2 },
      valuePolicyId: 'vp_cny_001',
    })
  })

  it('replays the same snapshot for a repeated idempotency key', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-idem@test.local', 'pass123', 'user', 2000)
    await createTestProduct('幂等定价', 300, 3, ['id-1', 'id-2', 'id-3'])
    const { accessToken } = await loginAs('vp-idem@test.local', 'pass123')
    const key = randomUUID()
    const body = { productId: 1, expectedPrice: 300, expectedValuePolicyId: 'vp_cny_001' }

    const first = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201)
    const replay = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201)

    expect(replay.body.orderId).toBe(first.body.orderId)
    expect(replay.body.pricing).toEqual(first.body.pricing)
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.orderPricingSnapshot.count()).toBe(1)
  })

  it('does not create a duplicate snapshot under concurrent same-key retries', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-race@test.local', 'pass123', 'user', 2000)
    await createTestProduct('并发定价', 200, 5, ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'])
    const { accessToken } = await loginAs('vp-race@test.local', 'pass123')
    const key = randomUUID()
    const body = { productId: 1, expectedPrice: 200, expectedValuePolicyId: 'vp_cny_001' }

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.post('/api/orders').set(authHeader(accessToken)).set('Idempotency-Key', key).send(body)
      )
    )
    const created = responses.filter(r => r.status === 201)
    expect(created.length).toBeGreaterThanOrEqual(1)
    expect(new Set(created.map(r => r.body.orderId)).size).toBe(1)
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.orderPricingSnapshot.count()).toBe(1)
  })

  it('fails closed when shadow mode has no active CNY policy', async () => {
    setMode('shadow')
    await createTestUser('vp-none@test.local', 'pass123', 'user', 2000)
    await createTestProduct('无政策', 100, 1, ['n-1'])
    const { accessToken } = await loginAs('vp-none@test.local', 'pass123')

    const preview = await api
      .get('/api/checkout/preview')
      .query({ productId: 1 })
      .set(authHeader(accessToken))
      .expect(503)
    expect(preview.body.error.code).toBe('VALUE_POLICY_UNAVAILABLE')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 100 })
      .expect(503)
    expect(created.body.error.code).toBe('VALUE_POLICY_UNAVAILABLE')
    expect(await prisma.order.count()).toBe(0)
  })

  it('fails closed when an active policy asset is disabled', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await prisma.$executeRawUnsafe('ALTER TABLE "AssetDefinition" DISABLE TRIGGER asset_definition_protect_row_guard')
    try {
      await prisma.assetDefinition.update({ where: { code: 'CNY' }, data: { enabled: false } })
      const res = await api.get('/api/value-policy/current').expect(500)
      expect(res.body.error.code).toBe('VALUE_POLICY_DATA_INVALID')
    } finally {
      await prisma.assetDefinition.update({ where: { code: 'CNY' }, data: { enabled: true } })
      await prisma.$executeRawUnsafe('ALTER TABLE "AssetDefinition" ENABLE TRIGGER asset_definition_protect_row_guard')
    }
  })
})
