// T-MERCH-BE-004 — Promotion billing/lifecycle/public REAL-PG integration tests.
// These tests intentionally exercise PostgreSQL row locks, the placement
// partial unique index and point-ledger transactions; mocks are not accepted.

import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import { HttpError } from '../../../lib/httpError.js'
import { CAMPAIGN_STATUS } from '../constants.js'
import { PROMOTION_ERROR_CODES } from '../promotions/constants.js'
import { createCampaign } from '../promotions/service.js'
import {
  adjustCampaignRefund,
  adminCancelCampaign,
  approveCampaign,
  pauseCampaign,
  resumeCampaign,
  retryCampaignPayment,
} from '../promotions/billing.js'
import { advanceCampaignLifecycle } from '../promotions/lifecycle.js'
import { invalidateSponsoredCache, listSponsoredItems } from '../promotions/publicSponsored.js'

const realPg = describe.skipIf(!process.env.TEST_DATABASE_URL)

let serial = 0
function uniq(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now()}-${serial}`
}

interface Fixture {
  adminUserId: number
  merchant: { id: number; userId: number }
  productId: number
  packageId: number
  pricePoints: number
}

async function cleanDatabase(): Promise<void> {
  await prisma.promotionCampaign.deleteMany()
  await prisma.promotionPackage.deleteMany()
  await prisma.adminLog.deleteMany()
  await prisma.pointLog.deleteMany()
  await prisma.pointAccount.deleteMany()
  await prisma.product.deleteMany()
  await prisma.productCategory.deleteMany()
  await prisma.merchant.deleteMany()
  await prisma.user.deleteMany()
  invalidateSponsoredCache()
}

async function setupFixture(balance = 10_000): Promise<Fixture> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('billing-admin')}@example.test`, password: 'x', role: 'admin' },
  })
  const merchantUser = await prisma.user.create({
    data: { email: `${uniq('billing-merchant')}@example.test`, password: 'x', role: 'merchant' },
  })
  const merchant = await prisma.merchant.create({
    data: { userId: merchantUser.id, name: uniq('merchant'), status: 'active' },
    select: { id: true, userId: true },
  })
  await prisma.pointAccount.create({ data: { userId: merchantUser.id, balance } })
  const category = await prisma.productCategory.create({
    data: {
      code: uniq('category'),
      label: uniq('分类'),
      normalizedLabel: uniq('normalized'),
      status: 'active',
      sortOrder: 0,
      createdByUserId: admin.id,
      updatedByUserId: admin.id,
    },
  })
  const product = await prisma.product.create({
    data: {
      name: uniq('商品'),
      type: '网络节点',
      price: 100,
      status: 'active',
      categoryId: category.id,
      merchantId: merchant.id,
    },
  })
  const pricePoints = 120
  const promotionPackage = await prisma.promotionPackage.create({
    data: {
      code: uniq('home-7d'),
      label: '首页推广 7 天',
      placement: 'store_home_sponsored',
      durationDays: 7,
      pricePoints,
      description: '',
      sortOrder: 0,
      status: 'active',
      createdByUserId: admin.id,
      updatedByUserId: admin.id,
    },
  })
  return {
    adminUserId: admin.id,
    merchant,
    productId: product.id,
    packageId: promotionPackage.id,
    pricePoints,
  }
}

async function requestCampaign(fx: Fixture, key: string, requestedStartAt: string | null = null) {
  const result = await createCampaign({
    merchantId: fx.merchant.id,
    campaignInput: { productId: fx.productId, packageId: fx.packageId, requestedStartAt },
    idempotencyKeyRaw: key,
  })
  return result.campaign
}

function errorCode(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') return null
  return result.reason instanceof HttpError ? String(result.reason.code) : null
}

realPg('promotions — billing and lifecycle (REAL-PG)', () => {
  beforeEach(cleanDatabase)

  it('100 concurrent approvals charge exactly once and never make balance negative', async () => {
    const fx = await setupFixture()
    const campaign = await requestCampaign(fx, 'approve-100')

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => approveCampaign(fx.adminUserId, campaign.id)),
    )
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => errorCode(result) === PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID)).toHaveLength(99)

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchant.userId } })
    expect(account.balance).toBe(10_000 - fx.pricePoints)
    expect(account.balance).toBeGreaterThanOrEqual(0)
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'out' } })).toBe(1)
    expect(await prisma.adminLog.count({ where: { targetType: 'promotion_campaign', targetId: campaign.id } })).toBe(1)
    const row = await prisma.promotionCampaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(row.status).toBe(CAMPAIGN_STATUS.ACTIVE)
    expect(row.chargePointLogId).not.toBeNull()
    expect(row.chargedPoints).toBe(fx.pricePoints)
  }, 30_000)

  it('insufficient balance records payment_failed with zero ledger rows, then retry charges the approved snapshot', async () => {
    const fx = await setupFixture(0)
    const campaign = await requestCampaign(fx, 'insufficient-retry')
    const failed = await approveCampaign(fx.adminUserId, campaign.id)
    expect(failed.kind).toBe('payment_failed')
    expect(failed.campaign.status).toBe(CAMPAIGN_STATUS.PAYMENT_FAILED)
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId } })).toBe(0)

    await prisma.pointAccount.update({ where: { userId: fx.merchant.userId }, data: { balance: 500 } })
    await prisma.promotionPackage.update({ where: { id: fx.packageId }, data: { status: 'inactive', pricePoints: 999 } })
    const retried = await retryCampaignPayment(fx.merchant.id, fx.merchant.userId, campaign.id)
    expect(retried.kind).toBe('charged')
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchant.userId } })
    expect(account.balance).toBe(500 - fx.pricePoints)
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'out' } })).toBe(1)
  })

  it('concurrent approval of two pending rows relies on the placement constraint and rolls one charge back', async () => {
    const fx = await setupFixture()
    const first = await requestCampaign(fx, 'placement-first')
    const second = await requestCampaign(fx, 'placement-second')

    const results = await Promise.allSettled([
      approveCampaign(fx.adminUserId, first.id),
      approveCampaign(fx.adminUserId, second.id),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => errorCode(result) === PROMOTION_ERROR_CODES.PLACEMENT_OCCUPIED)).toHaveLength(1)
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'out' } })).toBe(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchant.userId } })
    expect(account.balance).toBe(10_000 - fx.pricePoints)
    expect(await prisma.promotionCampaign.count({ where: { status: { in: ['active', 'scheduled', 'paused'] } } })).toBe(1)
  })

  it('scheduled cancel is a single full refund under concurrency and replay does not refund twice', async () => {
    const fx = await setupFixture()
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const campaign = await requestCampaign(fx, 'scheduled-cancel', future)
    const approved = await approveCampaign(fx.adminUserId, campaign.id)
    expect(approved.campaign.status).toBe(CAMPAIGN_STATUS.SCHEDULED)

    const cancels = await Promise.all(
      Array.from({ length: 30 }, () => adminCancelCampaign(fx.adminUserId, campaign.id, { reason: '取消排期' }, undefined)),
    )
    expect(cancels.filter(result => result.kind === 'cancelled')).toHaveLength(1)
    expect(cancels.filter(result => result.kind === 'replayed')).toHaveLength(29)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchant.userId } })
    expect(account.balance).toBe(10_000)
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'out' } })).toBe(1)
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'refund' } })).toBe(1)
  }, 30_000)

  it('100 same-key adjustments replay one immutable refund decision; a new key conflicts', async () => {
    const fx = await setupFixture()
    const campaign = await requestCampaign(fx, 'adjustment')
    await approveCampaign(fx.adminUserId, campaign.id)

    const decisions = await Promise.all(
      Array.from({ length: 100 }, () => adjustCampaignRefund(
        fx.adminUserId,
        campaign.id,
        { points: 40, reason: '服务补偿' },
        'adjustment-same-key',
      )),
    )
    expect(decisions.filter(result => result.kind === 'decided')).toHaveLength(1)
    expect(decisions.filter(result => result.kind === 'replayed')).toHaveLength(99)
    const row = await prisma.promotionCampaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(row.refundedPoints).toBe(40)
    expect(row.refundPointLogId).not.toBeNull()
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'refund' } })).toBe(1)

    await expect(adjustCampaignRefund(
      fx.adminUserId,
      campaign.id,
      { points: 40, reason: '服务补偿' },
      'adjustment-new-key',
    )).rejects.toMatchObject({ code: PROMOTION_ERROR_CODES.CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED })
  }, 30_000)

  it('zero-points adjustment writes the immutable decision but creates no refund ledger row (CHK-PROMO-009)', async () => {
    const fx = await setupFixture()
    const campaign = await requestCampaign(fx, 'zero-adjustment')
    await approveCampaign(fx.adminUserId, campaign.id)
    const balanceBefore = (await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchant.userId } })).balance

    const decided = await adjustCampaignRefund(
      fx.adminUserId,
      campaign.id,
      { points: 0, reason: '明确不退' },
      'zero-adjust-key',
    )
    expect(decided.kind).toBe('decided')

    // 不可变决定已写:adjustmentDecidedAt/by 落库;refund 侧全零、余额不动。
    const row = await prisma.promotionCampaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(row.adjustmentDecidedAt).not.toBeNull()
    expect(row.adjustmentByUserId).toBe(fx.adminUserId)
    expect(row.refundedPoints).toBe(0)
    expect(row.refundPointLogId).toBeNull()
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'refund' } })).toBe(0)
    const balanceAfter = (await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchant.userId } })).balance
    expect(balanceAfter).toBe(balanceBefore)

    // 同 key 重放返回既有零退款决定;新 key(即便金额不同)稳定 409;仍零 refund log。
    const replayed = await adjustCampaignRefund(
      fx.adminUserId,
      campaign.id,
      { points: 0, reason: '明确不退' },
      'zero-adjust-key',
    )
    expect(replayed.kind).toBe('replayed')
    await expect(adjustCampaignRefund(
      fx.adminUserId,
      campaign.id,
      { points: 10, reason: '第二次尝试' },
      'zero-adjust-second-key',
    )).rejects.toMatchObject({ code: PROMOTION_ERROR_CODES.CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED })
    expect(await prisma.pointLog.count({ where: { userId: fx.merchant.userId, type: 'refund' } })).toBe(0)
  }, 30_000)

  it('pause/resume is idempotent, and lifecycle uses DB time to converge delayed scheduled rows to expired', async () => {
    const fx = await setupFixture()
    const campaign = await requestCampaign(fx, 'pause-resume')
    await approveCampaign(fx.adminUserId, campaign.id)
    expect((await pauseCampaign(fx.adminUserId, campaign.id)).status).toBe(CAMPAIGN_STATUS.PAUSED)
    expect((await pauseCampaign(fx.adminUserId, campaign.id)).status).toBe(CAMPAIGN_STATUS.PAUSED)
    expect((await resumeCampaign(fx.adminUserId, campaign.id)).status).toBe(CAMPAIGN_STATUS.ACTIVE)
    expect((await resumeCampaign(fx.adminUserId, campaign.id)).status).toBe(CAMPAIGN_STATUS.ACTIVE)

    await prisma.promotionCampaign.update({
      where: { id: campaign.id },
      data: {
        status: CAMPAIGN_STATUS.SCHEDULED,
        startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    })
    const advanced = await advanceCampaignLifecycle()
    expect(advanced).toEqual({ scheduledToActive: 1, activeToExpired: 1 })
    expect((await prisma.promotionCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(CAMPAIGN_STATUS.EXPIRED)
  })

  it('public sponsored shelf returns only eligible active products with mandatory minimal disclosure', async () => {
    const fx = await setupFixture()
    const campaign = await requestCampaign(fx, 'public-sponsored')
    await approveCampaign(fx.adminUserId, campaign.id)
    const items = await listSponsoredItems({ placement: 'store_home_sponsored', limit: 12 })
    expect(items).toEqual([{ productId: fx.productId, disclosure: { code: 'sponsored', label: '推广' } }])
    expect(Object.keys(items[0]).sort()).toEqual(['disclosure', 'productId'])

    await prisma.merchant.update({ where: { id: fx.merchant.id }, data: { status: 'suspended' } })
    invalidateSponsoredCache()
    expect(await listSponsoredItems({ placement: 'store_home_sponsored', limit: 12 })).toEqual([])
  })
})
