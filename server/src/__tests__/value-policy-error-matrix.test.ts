import { afterEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import {
  orderPricingSnapshotCreatedTotal,
  orderPricingSnapshotFailureTotal,
  valuePolicyChangedTotal,
} from '../lib/metrics.js'
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

async function counterValue(counter: { get: () => Promise<{ values: Array<{ value: number }> }> }): Promise<number> {
  const metric = await counter.get()
  return metric.values.reduce((sum, item) => sum + item.value, 0)
}

async function expectNoOrderSideEffects(userId: number, before: {
  balance: number
  frozenBalance: number
  inventory: number
}) {
  expect(await prisma.order.count()).toBe(0)
  expect(await prisma.orderPricingSnapshot.count()).toBe(0)
  expect(await prisma.pointLog.count({ where: { type: { in: ['out', 'hold'] } } })).toBe(0)
  expect(await prisma.settlement.count()).toBe(0)
  expect(await prisma.inventoryLog.count()).toBe(0)
  expect(await prisma.idempotencyRecord.count()).toBe(0)
  expect(await prisma.deliveryRecord.count()).toBe(0)
  const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })
  expect(account.balance).toBe(before.balance)
  expect(account.frozenBalance).toBe(before.frozenBalance)
  expect(await prisma.inventoryItem.count({ where: { status: 'available' } })).toBe(before.inventory)
}

async function prepareBuyer(email: string, price = 400) {
  const { merchant } = await createTestMerchant(`${email}-m`, 'pass123', {
    role: 'merchant',
    status: 'active',
  })
  const { user } = await createTestUser(email, 'pass123', 'user', 2000)
  await createTestProduct('矩阵商品', price, 2, ['m-1', 'm-2'], merchant.id)
  const { accessToken } = await loginAs(email, 'pass123')
  const before = {
    balance: (await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance,
    frozenBalance: (await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance,
    inventory: await prisma.inventoryItem.count({ where: { status: 'available' } }),
  }
  return { user, accessToken, before }
}

afterEach(async () => {
  config.pointValuePolicyMode = originalMode
  await prisma.assetDefinition.updateMany({
    where: { code: { in: ['RP', 'CNY'] } },
    data: { enabled: true, retiredAt: null },
  }).catch(() => {})
})

describe('SPEC-VALUE-POLICY-P1-001 error-code matrix', () => {
  it('off ignores a well-formed expectedValuePolicyId and writes no snapshot', async () => {
    setMode('off')
    const { accessToken } = await prepareBuyer('vp-off-id@test.local', 200)
    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 200, expectedValuePolicyId: 'vp_ignored' })
      .expect(201)
    expect(created.body.pricing).toBeUndefined()
    expect(await prisma.orderPricingSnapshot.count()).toBe(0)
    expect(await prisma.valuePolicy.count()).toBe(0)
  })

  it('enforce missing expectedValuePolicyId is 400 before any side effects', async () => {
    setMode('enforce')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    const { user, accessToken, before } = await prepareBuyer('vp-enforce-required@test.local')
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 400 })
      .expect(400)
    expect(res.body.error.code).toBe('VALUE_POLICY_REQUIRED')
    await expectNoOrderSideEffects(user.id, before)
  })

  it.each([
    ['unknown ID', async () => 'vp_does_not_exist'],
    ['draft ID', async () => {
      await createTestCnyValuePolicy({ id: 'vp_draft', version: 11, status: 'draft' })
      return 'vp_draft'
    }],
    ['approved ID', async () => {
      await createTestCnyValuePolicy({ id: 'vp_approved', version: 12, status: 'approved' })
      return 'vp_approved'
    }],
    ['scheduled/future ID', async () => {
      await createTestCnyValuePolicy({
        id: 'vp_future',
        version: 13,
        status: 'scheduled',
        effectiveAt: new Date('2099-01-01T00:00:00.000Z'),
      })
      return 'vp_future'
    }],
    ['retired ID with no replacement', async () => {
      await createTestCnyValuePolicy({ id: 'vp_retired_alone', version: 14, status: 'retired' })
      return 'vp_retired_alone'
    }],
    ['retired ID with replacement', async () => {
      await createTestCnyValuePolicy({ id: 'vp_retired_old', version: 15 })
      await prisma.valuePolicy.update({
        where: { id: 'vp_retired_old' },
        data: { status: 'retired', retiredAt: new Date() },
      })
      await createTestCnyValuePolicy({ id: 'vp_retired_new', version: 16 })
      return 'vp_retired_old'
    }],
    ['non-CNY policy ID', async () => {
      await prisma.assetDefinition.upsert({
        where: { code: 'USD' },
        update: { enabled: true, retiredAt: null },
        create: { code: 'USD', kind: 'fiat', scale: 2, enabled: true },
      })
      await createTestCnyValuePolicy({
        id: 'vp_usd_scheduled',
        version: 17,
        status: 'scheduled',
        referenceAssetCode: 'USD',
      })
      return 'vp_usd_scheduled'
    }],
  ])('shadow/enforce %s returns 409 VALUE_POLICY_CHANGED with no side effects', async (_label, setup) => {
    setMode('enforce')
    const expectedValuePolicyId = await setup()
    const { user, accessToken, before } = await prepareBuyer('vp-changed@test.local')
    const changedBefore = await counterValue(valuePolicyChangedTotal)

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 400, expectedValuePolicyId })
      .expect(409)
    expect(res.body.error.code).toBe('VALUE_POLICY_CHANGED')
    expect(await counterValue(valuePolicyChangedTotal)).toBe(changedBefore + 1)
    await expectNoOrderSideEffects(user.id, before)
  })

  it('shadow without an ID and without an active policy is 503', async () => {
    setMode('shadow')
    const { user, accessToken, before } = await prepareBuyer('vp-shadow-none@test.local', 100)
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 100 })
      .expect(503)
    expect(res.body.error.code).toBe('VALUE_POLICY_UNAVAILABLE')
    await expectNoOrderSideEffects(user.id, before)
  })

  it('a concrete retired ID still returns 409 when no active replacement exists', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_only_retired', version: 21, status: 'retired' })
    const { user, accessToken, before } = await prepareBuyer('vp-retired-409@test.local', 100)
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 100, expectedValuePolicyId: 'vp_only_retired' })
      .expect(409)
    expect(res.body.error.code).toBe('VALUE_POLICY_CHANGED')
    await expectNoOrderSideEffects(user.id, before)
  })

  it('returns 500 VALUE_POLICY_DATA_INVALID when the active policy internals are corrupt', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await prisma.$executeRawUnsafe('ALTER TABLE "AssetDefinition" DISABLE TRIGGER asset_definition_protect_row_guard')
    try {
      await prisma.assetDefinition.update({ where: { code: 'CNY' }, data: { enabled: false } })
      const { user, accessToken, before } = await prepareBuyer('vp-invalid@test.local', 100)
      const res = await api
        .post('/api/orders')
        .set(authHeader(accessToken))
        .send({ productId: 1, expectedPrice: 100 })
        .expect(500)
      expect(res.body.error.code).toBe('VALUE_POLICY_DATA_INVALID')
      await expectNoOrderSideEffects(user.id, before)
    } finally {
      await prisma.assetDefinition.update({ where: { code: 'CNY' }, data: { enabled: true } })
      await prisma.$executeRawUnsafe('ALTER TABLE "AssetDefinition" ENABLE TRIGGER asset_definition_protect_row_guard')
    }
  })

  it('increments snapshot created only after commit, and failure after rollback', async () => {
    setMode('shadow')
    await createTestCnyValuePolicy({ id: 'vp_cny_001', version: 1 })
    await createTestUser('vp-snap-metric@test.local', 'pass123', 'user', 2000)
    await createTestProduct('无库存商品', 100, 0, [])
    const { accessToken } = await loginAs('vp-snap-metric@test.local', 'pass123')
    const createdBefore = await counterValue(orderPricingSnapshotCreatedTotal)
    const failedBefore = await counterValue(orderPricingSnapshotFailureTotal)

    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1, expectedPrice: 100, expectedValuePolicyId: 'vp_cny_001' })
      .expect(400)

    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.orderPricingSnapshot.count()).toBe(0)
    expect(await counterValue(orderPricingSnapshotCreatedTotal)).toBe(createdBefore)
    expect(await counterValue(orderPricingSnapshotFailureTotal)).toBe(failedBefore + 1)
  })
})
