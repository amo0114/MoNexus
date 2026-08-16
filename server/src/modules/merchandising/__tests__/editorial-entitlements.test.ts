// T-MERCH-BE-005 — Editorial and partner entitlement REAL-PG contracts.

import { beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { decorateProducts } from '../publicProjection.js'
import {
  advanceEditorialLifecycle,
  createEditorialFeature,
  revokeEditorialFeature,
  updateEditorialFeature,
} from '../editorial/service.js'
import { listEditorialShelf } from '../editorial/publicShelf.js'
import {
  __reconcilePartnerEntitlementsAtForTests,
  listMerchantEntitlements,
  manualGrantPartnerEntitlement,
  revokePartnerEntitlement,
} from '../entitlements/service.js'
import { adjustCampaignRefund, approveCampaign } from '../promotions/billing.js'
import { createCampaign } from '../promotions/service.js'

const realPg = describe.skipIf(!process.env.TEST_DATABASE_URL)
const DAY_MS = 86_400_000

let serial = 0
function uniq(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now()}-${serial}`
}

interface Fixture {
  adminId: number
  merchant: { id: number; userId: number }
  categoryId: number
  productId: number
  productName: string
  draftProductId: number
  packageId: number
}

async function cleanDatabase(): Promise<void> {
  await prisma.merchantEntitlement.deleteMany()
  await prisma.editorialFeature.deleteMany()
  await prisma.productMerchandisingSnapshot.deleteMany()
  await prisma.merchandisingRun.deleteMany()
  await prisma.promotionCampaign.deleteMany()
  await prisma.promotionPackage.deleteMany()
  await prisma.adminLog.deleteMany()
  await prisma.pointLog.deleteMany()
  await prisma.pointAccount.deleteMany()
  await prisma.product.deleteMany()
  await prisma.productCategory.deleteMany()
  await prisma.merchant.deleteMany()
  await prisma.user.deleteMany()
  await Promise.all([
    prisma.systemConfig.upsert({
      where: { key: 'partnerSpendWindowDays' },
      create: { key: 'partnerSpendWindowDays', value: 90, description: '合作伙伴自动授予窗口天数' },
      update: { value: 90, updatedBy: null },
    }),
    prisma.systemConfig.upsert({
      where: { key: 'partnerMinPromotionPoints' },
      create: { key: 'partnerMinPromotionPoints', value: 1000, description: '合作伙伴净推广消费门槛' },
      update: { value: 1000, updatedBy: null },
    }),
    prisma.systemConfig.upsert({
      where: { key: 'partnerEntitlementDays' },
      create: { key: 'partnerEntitlementDays', value: 30, description: '合作伙伴权益授予天数' },
      update: { value: 30, updatedBy: null },
    }),
  ])
}

async function setupFixture(): Promise<Fixture> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('be005-admin')}@example.test`, password: 'x', role: 'admin' },
  })
  const merchantUser = await prisma.user.create({
    data: { email: `${uniq('be005-merchant')}@example.test`, password: 'x', role: 'merchant' },
  })
  const merchant = await prisma.merchant.create({
    data: { userId: merchantUser.id, name: uniq('商家'), status: 'active' },
    select: { id: true, userId: true },
  })
  await prisma.pointAccount.create({ data: { userId: merchantUser.id, balance: 10_000 } })
  const category = await prisma.productCategory.create({
    data: {
      code: uniq('be005-category'),
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
      name: uniq('商品'), type: '网络节点', price: 100, status: 'active',
      categoryId: category.id, merchantId: merchant.id,
    },
  })
  const draftProduct = await prisma.product.create({
    data: {
      name: uniq('草稿'), type: '网络节点', price: 100, status: 'draft',
      categoryId: category.id, merchantId: merchant.id,
    },
  })
  const promotionPackage = await prisma.promotionPackage.create({
    data: {
      code: uniq('be005-package'), label: '合作伙伴门槛套餐',
      placement: 'store_home_sponsored', durationDays: 7, pricePoints: 600,
      description: '', sortOrder: 0, status: 'active',
      createdByUserId: admin.id, updatedByUserId: admin.id,
    },
  })
  return {
    adminId: admin.id,
    merchant,
    categoryId: category.id,
    productId: product.id,
    productName: product.name,
    draftProductId: draftProduct.id,
    packageId: promotionPackage.id,
  }
}

async function databaseNow(): Promise<Date> {
  const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AT TIME ZONE 'UTC' AS now`
  return now
}

async function createChargedCampaign(fx: Fixture, key: string) {
  const requested = await createCampaign({
    merchantId: fx.merchant.id,
    campaignInput: { productId: fx.productId, packageId: fx.packageId, requestedStartAt: null },
    idempotencyKeyRaw: key,
  })
  await approveCampaign(fx.adminId, requested.campaign.id)
  return prisma.promotionCampaign.findUniqueOrThrow({ where: { id: requested.campaign.id } })
}

function codeOf(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') return null
  return result.reason instanceof HttpError ? result.reason.code : null
}

realPg('editorial governance (REAL-PG)', () => {
  beforeEach(cleanDatabase)

  it('creates/patches/revokes with admin audit, uses DB lifecycle and hides inactive Product/Merchant', async () => {
    const fx = await setupFixture()
    const now = await databaseNow()
    await expect(createEditorialFeature(fx.adminId, {
      productId: fx.draftProductId,
      placement: 'store_editorial',
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + DAY_MS).toISOString(),
      internalReason: '内部选品',
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    const feature = await createEditorialFeature(fx.adminId, {
      productId: fx.productId,
      placement: 'store_editorial',
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + DAY_MS).toISOString(),
      publicReason: '本周上新',
      internalReason: '内部选品',
    })
    expect(feature.status).toBe('active')
    expect(feature.productName).toBe(fx.productName)
    expect(await listEditorialShelf()).toEqual([
      { productId: fx.productId, placement: 'store_editorial', publicReason: '本周上新', label: '平台精选' },
    ])
    const patched = await updateEditorialFeature(fx.adminId, feature.id, { publicReason: '精选理由更新', sortWeight: 9 })
    expect(patched.publicReason).toBe('精选理由更新')

    await prisma.product.update({ where: { id: fx.productId }, data: { status: 'inactive' } })
    expect(await listEditorialShelf()).toEqual([])
    await prisma.product.update({ where: { id: fx.productId }, data: { status: 'active' } })
    await prisma.merchant.update({ where: { id: fx.merchant.id }, data: { status: 'suspended' } })
    expect(await listEditorialShelf()).toEqual([])
    await prisma.merchant.update({ where: { id: fx.merchant.id }, data: { status: 'active' } })

    const revoked = await revokeEditorialFeature(fx.adminId, feature.id, '运营调整')
    expect(revoked.status).toBe('revoked')
    expect(await listEditorialShelf()).toEqual([])
    const logs = await prisma.adminLog.findMany({
      where: { targetType: 'editorial_feature', targetId: feature.id },
      orderBy: { id: 'asc' },
    })
    expect(logs).toHaveLength(3)
    expect(logs[2].detail).toContain('reason=运营调整')

    const scheduled = await createEditorialFeature(fx.adminId, {
      productId: fx.productId,
      placement: 'category_editorial',
      startsAt: new Date(now.getTime() + DAY_MS).toISOString(),
      endsAt: new Date(now.getTime() + 2 * DAY_MS).toISOString(),
      internalReason: '排期验证',
    })
    expect(scheduled.status).toBe('scheduled')
    await prisma.editorialFeature.update({
      where: { id: scheduled.id },
      data: { startsAt: new Date(now.getTime() - 2000), endsAt: new Date(now.getTime() + DAY_MS) },
    })
    expect(await advanceEditorialLifecycle()).toMatchObject({ scheduledToActive: 1 })
    await prisma.editorialFeature.update({ where: { id: scheduled.id }, data: { endsAt: new Date(now.getTime() - 1000) } })
    expect(await advanceEditorialLifecycle()).toMatchObject({ activeToExpired: 1 })
    expect((await prisma.editorialFeature.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe('expired')
  })
})

realPg('partner entitlement governance (REAL-PG)', () => {
  beforeEach(cleanDatabase)

  it('manual grant is 100-way safe, has bounded expiry/audit, minimal merchant DTO and immutable history', async () => {
    const fx = await setupFixture()
    const now = await databaseNow()
    await expect(manualGrantPartnerEntitlement(fx.adminId, {
      merchantId: fx.merchant.id,
      validUntil: new Date(now.getTime() + 366 * DAY_MS).toISOString(),
      reason: '超长授予',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    const grants = await Promise.allSettled(Array.from({ length: 100 }, () => manualGrantPartnerEntitlement(fx.adminId, {
      merchantId: fx.merchant.id,
      validUntil: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
      reason: '商务合作',
    })))
    expect(grants.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(grants.filter(result => codeOf(result) === 'CONFLICT')).toHaveLength(99)
    expect(await prisma.merchantEntitlement.count({ where: { merchantId: fx.merchant.id, status: 'active' } })).toBe(1)
    expect(await prisma.adminLog.count({ where: { action: '授予平台合作伙伴权益' } })).toBe(1)

    const merchantDto = await listMerchantEntitlements(fx.merchant.id)
    expect(merchantDto).toHaveLength(1)
    expect(Object.keys(merchantDto[0]).sort()).toEqual(['code', 'label', 'validFrom', 'validUntil'])
    expect(JSON.stringify(merchantDto)).not.toMatch(/source|reason|grantedBy|revokedBy/i)

    const active = await prisma.merchantEntitlement.findFirstOrThrow({ where: { merchantId: fx.merchant.id, status: 'active' } })
    await revokePartnerEntitlement(fx.adminId, active.id, '合作结束')
    expect(await listMerchantEntitlements(fx.merchant.id)).toEqual([])
    expect((await prisma.merchantEntitlement.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('revoked')
    expect(await prisma.merchantEntitlement.count({ where: { merchantId: fx.merchant.id } })).toBe(1)
    const revokeLog = await prisma.adminLog.findFirstOrThrow({ where: { action: '撤销平台合作伙伴权益' } })
    expect(revokeLog.detail).toContain('reason=合作结束')
  }, 30_000)

  it('uses charge-log [start,end), subtracts current refunds, grants/extends idempotently and expires without deleting history', async () => {
    const fx = await setupFixture()
    const now = await databaseNow()
    const windowStart = new Date(now.getTime() - 90 * DAY_MS)

    const lowerBound = await createChargedCampaign(fx, 'partner-lower-bound')
    await prisma.pointLog.update({ where: { id: lowerBound.chargePointLogId! }, data: { createdAt: windowStart } })
    await prisma.promotionCampaign.update({ where: { id: lowerBound.id }, data: { status: 'expired' } })

    const refundedInside = await createChargedCampaign(fx, 'partner-refunded-inside')
    await adjustCampaignRefund(fx.adminId, refundedInside.id, { points: 200, reason: '推广退款' }, 'partner-refund-once')
    await prisma.pointLog.update({
      where: { id: refundedInside.chargePointLogId! },
      data: { createdAt: new Date(now.getTime() - DAY_MS) },
    })
    await prisma.promotionCampaign.update({ where: { id: refundedInside.id }, data: { status: 'expired' } })

    const upperBound = await createChargedCampaign(fx, 'partner-upper-bound')
    await prisma.pointLog.update({ where: { id: upperBound.chargePointLogId! }, data: { createdAt: now } })
    await prisma.promotionCampaign.update({ where: { id: upperBound.id }, data: { status: 'expired' } })

    const concurrent = await Promise.all(
      Array.from({ length: 30 }, () => __reconcilePartnerEntitlementsAtForTests(now)),
    )
    expect(concurrent.reduce((sum, result) => sum + result.granted, 0)).toBe(1)
    expect(concurrent.reduce((sum, result) => sum + result.extended, 0)).toBe(0)
    expect(await prisma.merchantEntitlement.count({ where: { merchantId: fx.merchant.id, status: 'active' } })).toBe(1)
    const granted = await prisma.merchantEntitlement.findFirstOrThrow({ where: { merchantId: fx.merchant.id, status: 'active' } })
    expect(granted.reason).toContain('净推广消费1000积分')
    expect(granted.source).toBe('promotion_spend')

    expect(await __reconcilePartnerEntitlementsAtForTests(now)).toEqual({
      expired: 0, granted: 0, extended: 0, eligibleMerchants: 1,
    })
    await prisma.merchantEntitlement.update({
      where: { id: granted.id },
      data: { validUntil: new Date(now.getTime() + DAY_MS) },
    })
    expect((await __reconcilePartnerEntitlementsAtForTests(now)).extended).toBe(1)

    await prisma.systemConfig.update({ where: { key: 'partnerMinPromotionPoints' }, data: { value: 2000 } })
    const beforeBelowThreshold = await prisma.merchantEntitlement.findUniqueOrThrow({ where: { id: granted.id } })
    const belowThreshold = await __reconcilePartnerEntitlementsAtForTests(now)
    expect(belowThreshold.eligibleMerchants).toBe(0)
    expect((await prisma.merchantEntitlement.findUniqueOrThrow({ where: { id: granted.id } })).validUntil)
      .toEqual(beforeBelowThreshold.validUntil)

    const afterExpiry = await __reconcilePartnerEntitlementsAtForTests(new Date(now.getTime() + 31 * DAY_MS))
    expect(afterExpiry.expired).toBe(1)
    expect((await prisma.merchantEntitlement.findUniqueOrThrow({ where: { id: granted.id } })).status).toBe('expired')
    expect(await prisma.merchantEntitlement.count({ where: { merchantId: fx.merchant.id } })).toBe(1)
  }, 30_000)

  it('decorates editorial/partner identity even with no ranking run and hides both for an inactive merchant', async () => {
    const fx = await setupFixture()
    const now = await databaseNow()
    await createEditorialFeature(fx.adminId, {
      productId: fx.productId,
      placement: 'store_editorial',
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + DAY_MS).toISOString(),
      publicReason: '本周上新',
      internalReason: '投影验证',
    })
    await manualGrantPartnerEntitlement(fx.adminId, {
      merchantId: fx.merchant.id,
      validUntil: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
      reason: '投影验证',
    })
    const [decorated] = await decorateProducts([{ id: fx.productId, merchantId: fx.merchant.id }], null)
    expect(decorated.merchandising).toMatchObject({
      rankingRunId: null,
      hot: null,
      platformOwned: false,
      platformPick: { label: '平台精选', publicReason: '本周上新' },
      merchantPartner: { label: '平台合作伙伴' },
    })
    expect(Object.keys(decorated.merchandising.merchantPartner!).sort()).toEqual(['label', 'validUntil'])
    expect(JSON.stringify(decorated)).not.toMatch(/sourceRef|grantedBy|verified|guarantee/i)

    await prisma.merchant.update({ where: { id: fx.merchant.id }, data: { status: 'suspended' } })
    const [hidden] = await decorateProducts([{ id: fx.productId, merchantId: fx.merchant.id }], null)
    expect(hidden.merchandising.platformPick).toBeNull()
    expect(hidden.merchandising.merchantPartner).toBeNull()
  })
})
