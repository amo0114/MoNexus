import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

async function loginAdmin(email: string) {
  const { user } = await createTestUser(email, 'admin12345', 'admin')
  const auth = await loginAs(email, 'admin12345')
  return { user, ...auth }
}

async function loginNormalUser(email: string) {
  const { user } = await createTestUser(email, 'user12345', 'user')
  const auth = await loginAs(email, 'user12345')
  return { user, ...auth }
}

async function seedPricePolicy() {
  return prisma.rechargePricePolicy.create({
    data: {
      code: `rp-cny-${randomUUID()}`,
      version: 1,
      currency: 'CNY',
      currencyScale: 2,
      pointsNumerator: 1n,
      pointsDenominator: 1n,
      roundingMode: 'HALF_EVEN',
      minAmountMinor: 100n,
      maxAmountMinor: 100_000n,
      amountStepMinor: 100n,
      dailyLimitMinor: 200_000n,
      monthlyLimitMinor: 1_000_000n,
      limitTimeZone: 'Asia/Shanghai',
      status: 'active',
      effectiveAt: new Date(),
    },
  })
}

async function createRefundFixture(opts: {
  userId: number
  adminUserId: number
  policyId: string
  status?: string
  amountMinor?: bigint
  pointsToReverse?: bigint
  lastErrorCode?: string | null
  lastErrorSafeMessage?: string | null
  withReversal?: boolean
  withCreditOnly?: boolean
  reasonCode?: string
  createdByUserId?: number
  orderStatus?: string
  createdAt?: Date
  orderId?: string
}) {
  const orderId = opts.orderId ?? randomUUID()
  const quoteId = randomUUID()
  const intentId = randomUUID()
  const attemptId = randomUUID()
  const refundId = randomUUID()

  await prisma.rechargeQuote.create({
    data: {
      id: quoteId,
      userId: opts.userId,
      pricePolicyId: opts.policyId,
      currency: 'CNY',
      amountMinor: opts.amountMinor ?? 1000n,
      basePoints: opts.pointsToReverse ?? 1000n,
      bonusPoints: 0n,
      totalPoints: opts.pointsToReverse ?? 1000n,
      amountSource: 'custom',
      provider: 'simulator',
      paymentMethod: 'redirect',
      providerAccountKey: 'default',
      capabilityVersion: 'v1',
      capabilityDigest: 'test',
      effectiveMinAmountMinor: 100n,
      effectiveMaxAmountMinor: 100_000n,
      expiresAt: new Date(Date.now() + 3600000),
    },
  })

  await prisma.rechargeOrder.create({
    data: {
      id: orderId,
      userId: opts.userId,
      quoteId,
      pricePolicyId: opts.policyId,
      pricePolicyCode: 'rp-cny-test',
      pricePolicyVersion: 1,
      currency: 'CNY',
      currencyScale: 2,
      amountMinor: opts.amountMinor ?? 1000n,
      basePoints: opts.pointsToReverse ?? 1000n,
      bonusPoints: 0n,
      totalPoints: opts.pointsToReverse ?? 1000n,
      amountSource: 'custom',
      provider: 'simulator',
      paymentMethod: 'redirect',
      providerAccountKey: 'default',
      capabilityVersion: 'v1',
      capabilityDigest: 'test',
      effectiveMinAmountMinor: 100n,
      effectiveMaxAmountMinor: 100_000n,
      disclosureVersion: 'v1',
      pointsNumerator: 1n,
      pointsDenominator: 1n,
      roundingMode: 'HALF_EVEN',
      status: opts.orderStatus ?? 'refunded',
      creditedAt: (opts.withReversal || opts.withCreditOnly) ? (opts.createdAt ?? new Date()) : null,
      expiresAt: new Date(Date.now() + 3600000),
    },
  })

  await prisma.paymentIntent.create({
    data: {
      id: intentId,
      rechargeOrderId: orderId,
      status: 'succeeded',
      currency: 'CNY',
      amountMinor: opts.amountMinor ?? 1000n,
      expiresAt: new Date(Date.now() + 3600000),
    },
  })

  await prisma.paymentAttempt.create({
    data: {
      id: attemptId,
      paymentIntentId: intentId,
      provider: 'simulator',
      providerAccountKey: 'default',
      method: 'redirect',
      status: 'succeeded',
      requestIdempotencyKey: randomUUID(),
      actionType: 'redirect',
      expectedProviderAmountMinor: opts.amountMinor ?? 1000n,
      lastErrorCode: opts.lastErrorCode ?? null,
      lastErrorSafeMessage: opts.lastErrorSafeMessage ?? null,
    },
  })

  const refund = await prisma.rechargeRefund.create({
    data: {
      id: refundId,
      rechargeOrderId: orderId,
      paymentAttemptId: attemptId,
      requestIdempotencyKey: randomUUID(),
      amountMinor: opts.amountMinor ?? 1000n,
      pointsToReverse: opts.pointsToReverse ?? 1000n,
      status: opts.status ?? 'succeeded',
      reasonCode: opts.reasonCode ?? 'user_requested',
      createdByUserId: opts.createdByUserId ?? opts.adminUserId,
      createdAt: opts.createdAt ?? new Date(),
      updatedAt: opts.createdAt ?? new Date(),
    },
  })

  if (opts.withReversal || opts.withCreditOnly) {
    const creditId = randomUUID()
    const creditPointLog = await prisma.pointLog.create({
      data: {
        userId: opts.userId,
        type: 'recharge',
        amount: 1000,
        balanceAfter: 1000,
        orderId: null,
      },
    })
    await prisma.rechargeCredit.create({
      data: {
        id: creditId,
        rechargeOrderId: orderId,
        paymentIntentId: intentId,
        userId: opts.userId,
        points: opts.pointsToReverse ?? 1000n,
        balanceBefore: 0,
        balanceAfter: 1000,
        businessEventKey: `test:credit:${randomUUID()}`,
        pointLogId: creditPointLog.id,
        reversedAt: opts.withReversal ? (opts.createdAt ?? new Date()) : null,
      },
    })
    if (opts.withReversal) {
      const pointLog = await prisma.pointLog.create({
        data: {
          userId: opts.userId,
          type: 'recharge_reversal',
          amount: -1000,
          balanceAfter: 0,
          orderId: null,
        },
      })
      await prisma.rechargeReversal.create({
        data: {
          rechargeRefundId: refundId,
          rechargeCreditId: creditId,
          userId: opts.userId,
          points: opts.pointsToReverse ?? 1000n,
          balanceBefore: 1000,
          balanceAfter: 0,
          businessEventKey: `test:reversal:${randomUUID()}`,
          pointLogId: pointLog.id,
        },
      })
    }
  }

  return { refund, orderId }
}

describe('GET /api/admin/recharge/refunds', () => {
  beforeEach(async () => {
    await prisma.rechargeReversal.deleteMany()
    await prisma.rechargeRefund.deleteMany()
    await prisma.rechargeCredit.deleteMany()
    await prisma.paymentAttempt.deleteMany()
    await prisma.paymentIntent.deleteMany()
    await prisma.rechargeOrder.deleteMany()
    await prisma.rechargeQuote.deleteMany()
    await prisma.rechargePricePolicy.deleteMany()
  })

  afterEach(async () => {
    await prisma.rechargeReversal.deleteMany()
    await prisma.rechargeRefund.deleteMany()
  })

  it('rejects unauthenticated requests with 401 and non-admin with 403', async () => {
    await api.get('/api/admin/recharge/refunds').expect(401)

    const normalUser = await loginNormalUser('refund-norm@test.local')
    await api
      .get('/api/admin/recharge/refunds')
      .set(authHeader(normalUser.accessToken))
      .expect(403)
  })

  it('returns explicit required fields according to contract', async () => {
    const admin = await loginAdmin('refund-admin-fields@test.local')
    const user = await loginNormalUser('refund-user-fields@test.local')
    const policy = await seedPricePolicy()

    const { refund, orderId } = await createRefundFixture({
      userId: user.user.id,
      adminUserId: admin.user.id,
      policyId: policy.id,
      status: 'succeeded',
      withReversal: true,
      lastErrorCode: 'PROVIDER_FAIL_TEST',
      lastErrorSafeMessage: '银行卡扣款冲正异常',
    })

    const res = await api
      .get('/api/admin/recharge/refunds')
      .set(authHeader(admin.accessToken))
      .expect(200)

    expect(res.body.total).toBe(1)
    expect(res.body.page).toBe(1)
    expect(res.body.pageSize).toBe(20)
    expect(res.body.items).toHaveLength(1)

    const item = res.body.items[0]
    // 显式包含 RechargeRefund 关键字段：
    // refundId, orderId, rechargeOrder, refundStatus, reversalStatus, failureReason, createdByUserId, requesterUserId, requestSource, createdAt
    expect(item.refundId).toBe(refund.id)
    expect(item.orderId).toBe(orderId)
    expect(item.rechargeOrderId).toBe(orderId)
    expect(item.refundStatus).toBe('succeeded')
    expect(item.reversalStatus).toBe('completed')
    expect(item.failureReason).toBe('银行卡扣款冲正异常')
    expect(item.createdByUserId).toBe(admin.user.id)
    expect(item.requesterUserId).toBe(admin.user.id)
    expect(item.requestSource).toBeUndefined()
    expect(item.adminUserId).toBeUndefined()
    expect(item.createdAt).toBeDefined()
    expect(item.amountMinor).toBe('1000')
    expect(item.pointsToReverse).toBe('1000')

    // rechargeOrder 嵌套对象字段
    expect(item.rechargeOrder).toBeDefined()
    expect(item.rechargeOrder.id).toBe(orderId)
    expect(item.rechargeOrder.userId).toBe(user.user.id)
    expect(item.rechargeOrder.amountMinor).toBe('1000')
    expect(item.rechargeOrder.totalPoints).toBe('1000')
    expect(item.rechargeOrder.currency).toBe('CNY')
    expect(item.rechargeOrder.provider).toBe('simulator')
    expect(item.rechargeOrder.paymentMethod).toBe('redirect')
  })

  describe('pagination (boundaries, empty, out of bounds)', () => {
    it('returns empty array with total 0 on an empty table', async () => {
      const admin = await loginAdmin('refund-admin-empty@test.local')
      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ page: 1, pageSize: 20 })
        .expect(200)

      expect(res.body).toEqual({
        page: 1,
        pageSize: 20,
        total: 0,
        items: [],
      })
    })

    it('correctly handles custom pageSize and multiple pages', async () => {
      const admin = await loginAdmin('refund-admin-pages@test.local')
      const user = await loginNormalUser('refund-user-pages@test.local')
      const policy = await seedPricePolicy()

      // Create 5 refunds
      for (let i = 0; i < 5; i++) {
        await createRefundFixture({
          userId: user.user.id,
          adminUserId: admin.user.id,
          policyId: policy.id,
          status: 'succeeded',
        })
      }

      // Page 1: pageSize 2 -> items length 2, total 5
      const page1 = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ page: 1, pageSize: 2 })
        .expect(200)
      expect(page1.body.page).toBe(1)
      expect(page1.body.pageSize).toBe(2)
      expect(page1.body.total).toBe(5)
      expect(page1.body.items).toHaveLength(2)

      // Page 2: pageSize 2 -> items length 2, total 5
      const page2 = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ page: 2, pageSize: 2 })
        .expect(200)
      expect(page2.body.page).toBe(2)
      expect(page2.body.pageSize).toBe(2)
      expect(page2.body.total).toBe(5)
      expect(page2.body.items).toHaveLength(2)

      // Page 3: pageSize 2 -> items length 1, total 5
      const page3 = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ page: 3, pageSize: 2 })
        .expect(200)
      expect(page3.body.page).toBe(3)
      expect(page3.body.pageSize).toBe(2)
      expect(page3.body.total).toBe(5)
      expect(page3.body.items).toHaveLength(1)

      // Ensure items on page 1 and page 2 are distinct
      const idsPage1 = page1.body.items.map((it: any) => it.refundId)
      const idsPage2 = page2.body.items.map((it: any) => it.refundId)
      expect(idsPage1.some((id: string) => idsPage2.includes(id))).toBe(false)
    })

    it('returns empty items on out-of-bounds page without error', async () => {
      const admin = await loginAdmin('refund-admin-oob@test.local')
      const user = await loginNormalUser('refund-user-oob@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ page: 999, pageSize: 20 })
        .expect(200)

      expect(res.body.page).toBe(999)
      expect(res.body.total).toBe(1)
      expect(res.body.items).toEqual([])
    })
  })

  describe('reversalStatus financial accounting semantics', () => {
    it('returns completed for credited refund with RechargeReversal', async () => {
      const admin = await loginAdmin('rev-completed@test.local')
      const user = await loginNormalUser('rev-completed-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
        withReversal: true,
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('completed')
    })

    it('returns not_required for pre-credit refund that never issued points', async () => {
      const admin = await loginAdmin('rev-notreq@test.local')
      const user = await loginNormalUser('rev-notreq-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
        withReversal: false,
        withCreditOnly: false,
        orderStatus: 'refunded',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('not_required')
    })

    it('returns pending for credited refund where reversal has not finished (points_held)', async () => {
      const admin = await loginAdmin('rev-pending@test.local')
      const user = await loginNormalUser('rev-pending-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'points_held',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'credited',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('pending')
    })

    it('returns pending for credited refund in manual_review status', async () => {
      const admin = await loginAdmin('rev-manual@test.local')
      const user = await loginNormalUser('rev-manual-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'manual_review',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'credited',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('pending')
    })

    it('returns pending for credited refund in requested status', async () => {
      const admin = await loginAdmin('rev-requested@test.local')
      const user = await loginNormalUser('rev-requested-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'requested',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'credited',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('pending')
    })

    it('returns pending for credited refund in processing status', async () => {
      const admin = await loginAdmin('rev-processing@test.local')
      const user = await loginNormalUser('rev-processing-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'processing',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'credited',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('pending')
    })

    it('returns terminated for credited refund when refund status is failed', async () => {
      const admin = await loginAdmin('rev-failed@test.local')
      const user = await loginNormalUser('rev-failed-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'failed',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'credited',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('terminated')
    })

    it('returns terminated for credited refund when refund status is cancelled', async () => {
      const admin = await loginAdmin('rev-cancelled@test.local')
      const user = await loginNormalUser('rev-cancelled-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'cancelled',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'credited',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('terminated')
    })

    it('returns anomaly for credited refund when refund status is succeeded but lacks reversal', async () => {
      const admin = await loginAdmin('rev-anomaly@test.local')
      const user = await loginNormalUser('rev-anomaly-u@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
        withReversal: false,
        withCreditOnly: true,
        orderStatus: 'refunded',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].reversalStatus).toBe('anomaly')
    })
  })

  describe('requester identity semantics and role immutability', () => {
    it('reports createdByUserId and requesterUserId without adminUserId or mutable requestSource', async () => {
      const admin = await loginAdmin('req-immut-admin@test.local')
      const user = await loginNormalUser('req-immut-user@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        createdByUserId: user.user.id,
        policyId: policy.id,
        status: 'requested',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].requesterUserId).toBe(user.user.id)
      expect(res.body.items[0].createdByUserId).toBe(user.user.id)
      expect(res.body.items[0].requestSource).toBeUndefined()
      expect(res.body.items[0].adminUserId).toBeUndefined()
    })

    it('role mutation after refund creation preserves createdByUserId and does not inject admin status', async () => {
      const admin = await loginAdmin('req-role-admin@test.local')
      const user = await loginNormalUser('req-role-mut@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        createdByUserId: user.user.id,
        policyId: policy.id,
        status: 'requested',
      })

      // Promote the user to admin in DB after refund creation
      await prisma.user.update({
        where: { id: user.user.id },
        data: { role: 'admin' },
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].requesterUserId).toBe(user.user.id)
      expect(res.body.items[0].createdByUserId).toBe(user.user.id)
      expect(res.body.items[0].requestSource).toBeUndefined()
      expect(res.body.items[0].adminUserId).toBeUndefined()
    })
  })

  describe('filtering combinations', () => {
    it('filters by status enum and rejects invalid status with 400', async () => {
      const admin = await loginAdmin('refund-admin-status@test.local')
      const user = await loginNormalUser('refund-user-status@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
      })
      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'failed',
      })
      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'requested',
      })

      // Query succeeded
      const resSucc = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ status: 'succeeded' })
        .expect(200)
      expect(resSucc.body.total).toBe(1)
      expect(resSucc.body.items[0].refundStatus).toBe('succeeded')

      // Query failed
      const resFail = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ status: 'failed' })
        .expect(200)
      expect(resFail.body.total).toBe(1)
      expect(resFail.body.items[0].refundStatus).toBe('failed')

      // Query requested
      const resReq = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ status: 'requested' })
        .expect(200)
      expect(resReq.body.total).toBe(1)
      expect(resReq.body.items[0].refundStatus).toBe('requested')

      // Reject non-existent database status with 400
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ status: 'approved' })
        .expect(400)

      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ status: 'not_a_valid_status' })
        .expect(400)
    })

    it('filters by userId', async () => {
      const admin = await loginAdmin('refund-admin-userfilt@test.local')
      const userA = await loginNormalUser('refund-user-a@test.local')
      const userB = await loginNormalUser('refund-user-b@test.local')
      const policy = await seedPricePolicy()

      const refA = await createRefundFixture({
        userId: userA.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
      })
      await createRefundFixture({
        userId: userB.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
      })

      // Filter by userA
      const resUserA = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ userId: userA.user.id })
        .expect(200)
      expect(resUserA.body.total).toBe(1)
      expect(resUserA.body.items[0].orderId).toBe(refA.orderId)
    })

    it('rejects non-canonical or non-UUID orderId queries with 400', async () => {
      const admin = await loginAdmin('refund-admin-short@test.local')

      // Prefix-only string without remaining UUID structure
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: 'a1b2c3d4' })
        .expect(400)

      // Short input (< 8 chars)
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: '1234' })
        .expect(400)

      // Only 7 hex characters with trailing hyphen (previously bypassed hexCount < 8 && val.length < 8)
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: 'abcdef7-' })
        .expect(400)

      // Only hyphens (previously bypassed hexCount < 8 && val.length < 8)
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: '--------' })
        .expect(400)

      // Non-hex characters
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: 'not-valid-hex!' })
        .expect(400)

      // Super-long string (> 36 chars)
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: 'c0a80101-0000-4000-8000-000000000001-extra-characters' })
        .expect(400)

      // Misplaced hyphens (8-8-4-12 instead of 8-4-4-4-12)
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: 'c0a80101-00004000-8000-000000000001' })
        .expect(400)

      // Missing characters (35 chars)
      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: 'c0a80101-0000-4000-8000-00000000000' })
        .expect(400)
    })

    it('filters by full exact UUID orderId in isolation and combined with userId', async () => {
      const admin = await loginAdmin('refund-admin-uuid@test.local')
      const userA = await loginNormalUser('refund-user-ua@test.local')
      const userB = await loginNormalUser('refund-user-ub@test.local')
      const policy = await seedPricePolicy()

      const targetOrderId = 'a1b2c3d4-1111-4000-8000-000000000001'
      const otherOrderId = 'ffffffff-2222-4000-8000-000000000002'

      const refA = await createRefundFixture({
        userId: userA.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
        orderId: targetOrderId,
      })
      await createRefundFixture({
        userId: userB.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
        orderId: otherOrderId,
      })

      // 1. Exact UUID match returns exactly 1 item
      const resExact = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: targetOrderId })
        .expect(200)

      expect(resExact.body.total).toBe(1)
      expect(resExact.body.items).toHaveLength(1)
      expect(resExact.body.items[0].orderId).toBe(targetOrderId)
      expect(resExact.body.items[0].refundId).toBe(refA.refund.id)

      // 2. Exact UUID non-existent returns empty items
      const resNonExistent = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ orderId: '00000000-0000-4000-8000-000000000000' })
        .expect(200)

      expect(resNonExistent.body.total).toBe(0)
      expect(resNonExistent.body.items).toHaveLength(0)

      // 3. Combined filter (matching userId + matching orderId)
      const resMatchCombo = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ userId: userA.user.id, orderId: targetOrderId })
        .expect(200)

      expect(resMatchCombo.body.total).toBe(1)
      expect(resMatchCombo.body.items[0].orderId).toBe(targetOrderId)

      // 4. Combined filter (non-matching userId + orderId)
      const resMismatchCombo = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ userId: userB.user.id, orderId: targetOrderId })
        .expect(200)

      expect(resMismatchCombo.body.total).toBe(0)
      expect(resMismatchCombo.body.items).toHaveLength(0)
    })

    it('supports combined filters (userId + status)', async () => {
      const admin = await loginAdmin('refund-admin-combo@test.local')
      const userA = await loginNormalUser('refund-combo-a@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: userA.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
      })
      await createRefundFixture({
        userId: userA.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'failed',
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ userId: userA.user.id, status: 'succeeded' })
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].refundStatus).toBe('succeeded')
    })
  })

  describe('date range filtering with half-open interval and boundary guarantees', () => {
    it('includes records within [from, to] including to-date end of day for YYYY-MM-DD', async () => {
      const admin = await loginAdmin('refund-admin-date@test.local')
      const user = await loginNormalUser('refund-user-date@test.local')
      const policy = await seedPricePolicy()

      // Target day: 2026-09-02
      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        createdAt: new Date('2026-09-02T08:30:00.000Z'),
      })

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        createdAt: new Date('2026-09-02T23:59:59.999Z'),
      })

      // Next day: 2026-09-03
      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        createdAt: new Date('2026-09-03T00:00:00.000Z'),
      })

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-09-02', to: '2026-09-02' })
        .expect(200)

      expect(res.body.total).toBe(2)
      expect(res.body.items).toHaveLength(2)
    })

    it('supports strict RFC 3339 timestamps with explicit timezone', async () => {
      const admin = await loginAdmin('refund-admin-rfc@test.local')
      const user = await loginNormalUser('refund-user-rfc@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      })

      // Within range
      const resIn = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-09-02T10:00:00Z', to: '2026-09-02T14:00:00Z' })
        .expect(200)

      expect(resIn.body.total).toBe(1)

      // Outside range
      const resOut = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-09-02T13:00:00Z', to: '2026-09-02T14:00:00Z' })
        .expect(200)

      expect(resOut.body.total).toBe(0)
    })

    it('rejects missing timezone in full timestamp with 400', async () => {
      const admin = await loginAdmin('refund-admin-notz@test.local')

      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-09-04T12:30:00' })
        .expect(400)
    })

    it('rejects invalid calendar dates with timestamp with 400', async () => {
      const admin = await loginAdmin('refund-admin-invts@test.local')

      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-02-31T00:00:00Z' })
        .expect(400)

      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-04-31T12:00:00+08:00' })
        .expect(400)
    })

    it('rejects naked invalid calendar date with 400', async () => {
      const admin = await loginAdmin('refund-admin-invdate@test.local')

      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-02-31' })
        .expect(400)

      await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: 'invalid-date' })
        .expect(400)
    })

    it('rejects reverse date range from > to with 400', async () => {
      const admin = await loginAdmin('refund-admin-revdate@test.local')

      const res = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .query({ from: '2026-09-05', to: '2026-09-04' })
        .expect(400)

      expect(JSON.stringify(res.body)).toContain('from 不能晚于 to')
    })
  })

  describe('route alias /api/admin/recharge-refunds equivalence', () => {
    it('returns identical data between /recharge-refunds and /recharge/refunds', async () => {
      const admin = await loginAdmin('refund-admin-equiv@test.local')
      const user = await loginNormalUser('refund-user-equiv@test.local')
      const policy = await seedPricePolicy()

      await createRefundFixture({
        userId: user.user.id,
        adminUserId: admin.user.id,
        policyId: policy.id,
        status: 'succeeded',
        withReversal: true,
      })

      const res1 = await api
        .get('/api/admin/recharge/refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      const res2 = await api
        .get('/api/admin/recharge-refunds')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res2.body).toEqual(res1.body)
    })
  })
})
