import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { computeLifetimeEarnedPoints } from '../lib/memberTier.js'
import { creditInTx, findWalletInvariantViolations } from '../modules/wallet/index.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  spendTestPoints,
} from './helpers.js'

async function grant(userId: number, key: string, amount: number, origin: 'recharge' | 'reward') {
  await prisma.$transaction(tx => creditInTx(tx, {
    operationKey: key,
    userId,
    source: { kind: 'test', id: key },
    reasonCode: origin,
    log: { reason: key, growthEligible: origin === 'reward' },
  }, { amount, origin }))
}

async function lotsByOrigin(userId: number) {
  const lots = await prisma.pointLot.findMany({ where: { userId }, orderBy: { id: 'asc' } })
  const result: Record<string, { available: number; consumed: number }> = {}
  for (const lot of lots) {
    const row = result[lot.originKind] ??= { available: 0, consumed: 0 }
    row.available += lot.availablePoints
    row.consumed += lot.consumedPoints
  }
  return result
}

async function buyAndClose(buyerToken: string, productId: number) {
  const order = await api.post('/api/orders').set(authHeader(buyerToken)).send({ productId }).expect(201)
  await api.post(`/api/orders/${order.body.orderId}/close`).set(authHeader(buyerToken)).expect(200)
  return order.body.orderId as number
}

describe('commerce accounting closure', () => {
  it('refunds a settled order to its original sources and tracks the merchant shortfall', async () => {
    await createTestUser('closure-admin@test.local', 'admin123', 'admin')
    const { user: buyer } = await createTestUser('closure-buyer@test.local', 'buyer123', 'user', 0)
    const { merchant, user: merchantUser } = await createTestMerchant('closure-merchant@test.local', 'merchant123', {
      status: 'active',
      balance: 0,
    })
    await grant(buyer.id, 'closure:recharge', 700, 'recharge')
    await grant(buyer.id, 'closure:reward', 300, 'reward')
    const product = await createTestProduct('闭环商品', 1000, 2, ['k-1', 'k-2'], merchant.id)
    const buyerLogin = await loginAs('closure-buyer@test.local', 'buyer123')
    const orderId = await buyAndClose(buyerLogin.accessToken, product.id)
    expect(await lotsByOrigin(buyer.id)).toEqual({
      recharge: { available: 0, consumed: 700 },
      reward: { available: 0, consumed: 300 },
    })

    const admin = await loginAs('closure-admin@test.local', 'admin123')
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    const batch = await api.post('/api/admin/settlements/batch-settle').set(authHeader(admin.accessToken))
      .send({ settlementIds: [settlement.id], requestKey: 'closure-batch-1' }).expect(200)
    expect(batch.body).toMatchObject({ settled: 1, creditedTotal: 900, replayed: false })
    const replay = await api.post('/api/admin/settlements/batch-settle').set(authHeader(admin.accessToken))
      .send({ settlementIds: [settlement.id], requestKey: 'closure-batch-1' }).expect(200)
    expect(replay.body).toMatchObject({ batchId: batch.body.batchId, replayed: true })
    await api.post('/api/admin/settlements/batch-settle').set(authHeader(admin.accessToken))
      .send({ settlementIds: [settlement.id + 1000], requestKey: 'closure-batch-1' }).expect(409)

    // The merchant already spent part of the earning.
    await spendTestPoints(merchantUser.id, 400)

    const created = await api.post(`/api/admin/orders/${orderId}/after-sales`).set(authHeader(admin.accessToken))
      .send({ reason: '商品与描述严重不符' }).expect(201)
    expect(created.body).toMatchObject({ status: 'open', estimatedShortfall: 400, paymentComposition: { recharge: 700, reward: 300 } })
    await api.post(`/api/admin/orders/${orderId}/after-sales`).set(authHeader(admin.accessToken))
      .send({ reason: '重复' }).expect(409)
    const executed = await api.post(`/api/admin/after-sales/${created.body.id}/execute`).set(authHeader(admin.accessToken))
      .send({}).expect(200)
    expect(executed.body.adjustment).toMatchObject({ settlementDelta: -900, commissionDelta: -100, clawbackPoints: 500 })
    expect(executed.body.adjustment.recoveryCase).toMatchObject({ amountDue: 400, status: 'open' })

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('closed')
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })).toMatchObject({ balance: 1000 })
    // Rewards come back as rewards: refunds never launder sources.
    expect(await lotsByOrigin(buyer.id)).toEqual({
      recharge: { available: 700, consumed: 0 },
      reward: { available: 300, consumed: 0 },
    })
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: merchantUser.id } })).toMatchObject({ balance: 0 })
    // The refund is neither growth nor a second refund path.
    expect(await computeLifetimeEarnedPoints(buyer.id)).toBe(300)
    await api.post(`/api/admin/orders/${orderId}/resolve`).set(authHeader(admin.accessToken))
      .send({ result: 'refund' }).expect(400)

    // An open shortfall stops this merchant's next settlement until it is handled.
    const secondOrderId = await buyAndClose(buyerLogin.accessToken, product.id)
    const second = await prisma.settlement.findUniqueOrThrow({ where: { orderId: secondOrderId } })
    await api.post('/api/admin/settlements/batch-settle').set(authHeader(admin.accessToken))
      .send({ settlementIds: [second.id] }).expect(400)
    const recovery = executed.body.adjustment.recoveryCase
    await api.post(`/api/admin/merchant-recovery-cases/${recovery.id}/actions`).set(authHeader(admin.accessToken))
      .send({ kind: 'offline_received', amount: 400, requestKey: 'closure-recovery-1' }).expect(400)
    const closed = await api.post(`/api/admin/merchant-recovery-cases/${recovery.id}/actions`).set(authHeader(admin.accessToken))
      .send({ kind: 'offline_received', amount: 400, requestKey: 'closure-recovery-1', evidence: '转账凭证 #A1' }).expect(200)
    expect(closed.body).toMatchObject({ status: 'closed', outstanding: 0, allowedActions: [] })
    await api.post('/api/admin/settlements/batch-settle').set(authHeader(admin.accessToken))
      .send({ settlementIds: [second.id] }).expect(200)

    const merchantLogin = await loginAs('closure-merchant@test.local', 'merchant123')
    const summary = await api.get('/api/merchant/finance/summary').set(authHeader(merchantLogin.accessToken)).expect(200)
    expect(summary.body).toMatchObject({ netEarned: 900, credited: 1800, clawedBack: 500, outstandingRecovery: 0, walletBalance: 900 })

    expect(await findWalletInvariantViolations()).toEqual([])
  })

  it('does not let merchants buy their own goods or admins trade with points', async () => {
    const { user: adminUser } = await createTestUser('closure-admin2@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('closure-self@test.local', 'merchant123', { status: 'active' })
    const own = await createTestProduct('自家商品', 100, 1, ['own-1'], merchant.id)
    const platform = await createTestProduct('平台商品', 100, 1, ['platform-1'])

    const merchantLogin = await loginAs('closure-self@test.local', 'merchant123')
    const self = await api.post('/api/orders').set(authHeader(merchantLogin.accessToken)).send({ productId: own.id }).expect(400)
    expect(self.body.error.code).toBe('PURCHASE_NOT_ALLOWED')
    const preview = await api.get(`/api/checkout/preview?productId=${own.id}`).set(authHeader(merchantLogin.accessToken)).expect(200)
    expect(preview.body.unpurchasableReason).toBe('不能购买自己店铺的商品')

    const admin = await loginAs('closure-admin2@test.local', 'admin123')
    const adminOrder = await api.post('/api/orders').set(authHeader(admin.accessToken)).send({ productId: platform.id }).expect(400)
    expect(adminOrder.body.error.code).toBe('PURCHASE_NOT_ALLOWED')
    await api.post(`/api/admin/users/${adminUser.id}/adjust`).set(authHeader(admin.accessToken))
      .set('Idempotency-Key', 'self-adjust').send({ type: 'add', amount: 100, reason: '自加' }).expect(400)
    expect(await prisma.order.count()).toBe(0)
  })
})
