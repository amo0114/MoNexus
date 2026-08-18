import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { convertPointsToReferenceAtomic } from '../modules/valuePolicy/money.js'
import {
  HALF_EVEN_OVERFLOW_VECTOR,
  HALF_EVEN_VECTORS,
  PG_INT8_MAX,
} from '../modules/valuePolicy/roundingVectors.js'
import { getActiveCategoryIdByLabel } from './catalogFixture.js'
import { createTestCnyValuePolicy } from './helpers.js'

describe('Product and InventoryItem database constraints', () => {
  it('rejects invalid product commercial values and finite state values', async () => {
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const invalidProducts = [
      { name: '零价格', type: '充值卡密', price: 0, categoryId },
      { name: '倒挂原价', type: '充值卡密', price: 100, originalPrice: 99, categoryId },
      { name: '负库存', type: '充值卡密', price: 100, stock: -1, categoryId },
      { name: '负销量', type: '充值卡密', price: 100, sales: -1, categoryId },
      { name: '非法上下架状态', type: '充值卡密', price: 100, status: 'archived', categoryId },
      { name: '非法履约方式', type: '充值卡密', price: 100, deliveryMode: 'scheduled', categoryId },
      { name: '非法库存方式', type: '充值卡密', price: 100, stockMode: 'reserved', categoryId },
      { name: '非法固定内容类型', type: '充值卡密', price: 100, fixedContentType: 'html', categoryId },
      {
        name: '即时库存不能不限量', type: '充值卡密', price: 100, categoryId,
        deliveryMode: 'instant_inventory', stockMode: 'unlimited',
      },
    ]
    for (const data of invalidProducts) {
      await expect(prisma.product.create({ data })).rejects.toThrow()
    }
  })

  it('rejects an inventory item with an invalid lifecycle state', async () => {
    const product = await prisma.product.create({
      data: { name: '库存状态约束商品', type: '充值卡密', price: 100, categoryId: await getActiveCategoryIdByLabel('充值卡密') },
    })
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '默认规格', isDefault: true, price: 100 },
    })

    await expect(prisma.inventoryItem.create({
      data: { productId: product.id, offerId: offer.id, content: 'INVALID-STATUS-CARD', status: 'reserved' },
    })).rejects.toThrow()
  })

  it('enforces auditable inventory movement semantics at the database layer', async () => {
    const product = await prisma.product.create({
      data: { name: '库存流水约束商品', type: '充值卡密', price: 100, categoryId: await getActiveCategoryIdByLabel('充值卡密') },
    })

    await expect(prisma.inventoryLog.create({
      data: { productId: product.id, actorUserId: 1, action: 'import', delta: 1 },
    })).rejects.toThrow()
    await expect(prisma.inventoryLog.create({
      data: {
        productId: product.id,
        actorUserId: 1,
        action: 'void',
        delta: 1,
        batchId: '11111111-1111-4111-8111-111111111111',
      },
    })).rejects.toThrow()
    await expect(prisma.inventoryLog.create({
      data: { productId: product.id, actorUserId: 1, action: 'sale', delta: -1 },
    })).rejects.toThrow()
  })
})

// P5 T2：file 形态与签名发放审计的数据库约束。
describe('P5 file-delivery database constraints', () => {
  async function makeFile(merchantId: number, marker: string) {
    return prisma.deliveryFile.create({
      data: {
        key: `${marker.repeat(8).slice(0, 32)}.bin`,
        fileName: 'paid.bin',
        size: 10,
        mimeType: 'application/octet-stream',
        sha256: marker.repeat(16).slice(0, 64),
        merchantId,
      },
    })
  }

  async function makeMerchantWithProduct(suffix: string) {
    const user = await prisma.user.create({
      data: { email: `file-cons-${suffix}@test.local`, password: 'x', role: 'merchant' },
    })
    const merchant = await prisma.merchant.create({
      data: { userId: user.id, name: `文件约束商家${suffix}`, status: 'active' },
    })
    const product = await prisma.product.create({
      data: { name: `文件约束商品${suffix}`, type: '充值卡密', price: 100, merchantId: merchant.id, categoryId: await getActiveCategoryIdByLabel('充值卡密') },
    })
    return { merchant, product }
  }

  it('enforces the file-form invariants on Offer', async () => {
    const { merchant, product } = await makeMerchantWithProduct('a')
    const file = await makeFile(merchant.id, 'a1')

    // file 形态缺 fixedFileId → 拒绝。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格1', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file',
      },
    })).rejects.toThrow()

    // file 形态还塞 fixedContent → 拒绝（文件真相源是 fixedFileId）。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格2', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file',
        fixedFileId: file.id, fixedContent: 'https://leak.example',
      },
    })).rejects.toThrow()

    // 非 instant_fixed 不能挂 file 形态。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格3', price: 100,
        deliveryMode: 'manual_service', stockMode: 'unlimited', fixedContentType: 'file',
        fixedFileId: file.id,
      },
    })).rejects.toThrow()

    // 非 file 形态不能挂 fixedFileId。
    await expect(prisma.offer.create({
      data: {
        productId: product.id, name: '坏文件规格4', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: '固定文本', fixedFileId: file.id,
      },
    })).rejects.toThrow()

    // 合法 file 形态：instant_fixed + fixedFileId + 空 fixedContent。
    const ok = await prisma.offer.create({
      data: {
        productId: product.id, name: '文件规格', price: 100,
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContentType: 'file', fixedFileId: file.id,
      },
    })
    expect(ok.fixedFileId).toBe(file.id)

    // 被在售规格引用的文件不可删（RESTRICT）。
    await expect(prisma.deliveryFile.delete({ where: { id: file.id } })).rejects.toThrow()
  })

  it('restricts FileGrantLog role/outcome vocabularies', async () => {
    const { merchant, product } = await makeMerchantWithProduct('b')
    const file = await makeFile(merchant.id, 'b2')
    const buyer = await prisma.user.create({
      data: { email: 'file-cons-buyer@test.local', password: 'x' },
    })
    const order = await prisma.order.create({
      data: { userId: buyer.id, productId: product.id, price: 100 },
    })

    await expect(prisma.fileGrantLog.create({
      data: { fileId: file.id, orderId: order.id, userId: buyer.id, role: 'stranger', outcome: 'granted' },
    })).rejects.toThrow()
    await expect(prisma.fileGrantLog.create({
      data: { fileId: file.id, orderId: order.id, userId: buyer.id, role: 'buyer', outcome: 'maybe' },
    })).rejects.toThrow()

    const ok = await prisma.fileGrantLog.create({
      data: {
        fileId: file.id, orderId: order.id, userId: buyer.id,
        role: 'buyer', outcome: 'granted', expiresAt: new Date(Date.now() + 300_000),
      },
    })
    expect(ok.id).toBeGreaterThan(0)
  })
})

describe('SPEC-VALUE-POLICY-P1-001 database constraints', () => {
  async function seedUsdAsset() {
    return prisma.assetDefinition.upsert({
      where: { code: 'USD' },
      update: {},
      create: { code: 'USD', kind: 'fiat', scale: 2, enabled: false },
    })
  }

  async function seedUsdtAsset() {
    return prisma.assetDefinition.upsert({
      where: { code: 'USDT' },
      update: {},
      create: { code: 'USDT', kind: 'fiat', scale: 6, enabled: false },
    })
  }

  it('rejects a zero or negative policy ratio', async () => {
    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_bad_zero',
        version: 9001,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 0n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'draft',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })).rejects.toThrow()

    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_bad_neg',
        version: 9002,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: -1n,
        roundingMode: 'HALF_EVEN',
        status: 'draft',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })).rejects.toThrow()
  })

  it('rejects a second active policy for the same point asset', async () => {
    await createTestCnyValuePolicy({
      id: 'vp_active_one',
      version: 9101,
    })

    await expect(createTestCnyValuePolicy({
      id: 'vp_active_two',
      version: 9102,
    })).rejects.toThrow()

    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_active_insert',
        version: 9103,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'active',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })).rejects.toThrow(/value_policy_insert_must_be_draft/)
  })

  it('rejects updates to economic fields of an active policy', async () => {
    await createTestCnyValuePolicy({
      id: 'vp_locked',
      version: 9201,
    })

    await expect(prisma.valuePolicy.update({
      where: { id: 'vp_locked' },
      data: { referenceAtomicPerPointNumerator: 2n },
    })).rejects.toThrow()
  })

  it('rejects a draft-to-active jump and an active USD/USDT policy', async () => {
    await prisma.valuePolicy.create({
      data: {
        id: 'vp_draft',
        version: 9301,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'draft',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })
    await expect(prisma.valuePolicy.update({
      where: { id: 'vp_draft' },
      data: { status: 'active' },
    })).rejects.toThrow()

    await seedUsdAsset()
    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_usd_active',
        version: 9302,
        pointAssetCode: 'RP',
        referenceAssetCode: 'USD',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'active',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })).rejects.toThrow()

    await seedUsdtAsset()
    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_usdt_active',
        version: 9303,
        pointAssetCode: 'RP',
        referenceAssetCode: 'USDT',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'active',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })).rejects.toThrow()
  })

  it('rejects snapshot updates/deletes and orphan snapshots', async () => {
    const user = await prisma.user.create({
      data: { email: 'vp-snap@test.local', password: 'x' },
    })
    const product = await prisma.product.create({
      data: { name: '快照约束商品', type: '充值卡密', price: 100, categoryId: await getActiveCategoryIdByLabel('充值卡密') },
    })
    const order = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 100 },
    })
    const policy = await createTestCnyValuePolicy({
      id: 'vp_snap',
      version: 9401,
    })
    const snapshot = await prisma.orderPricingSnapshot.create({
      data: {
        orderId: order.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 100n,
        roundingMode: 'HALF_EVEN',
      },
    })

    await expect(prisma.orderPricingSnapshot.update({
      where: { orderId: snapshot.orderId },
      data: { referenceAmountAtomic: 1n },
    })).rejects.toThrow()
    await expect(prisma.orderPricingSnapshot.delete({
      where: { orderId: snapshot.orderId },
    })).rejects.toThrow()

    await expect(prisma.orderPricingSnapshot.create({
      data: {
        orderId: 9_999_999,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 100n,
        roundingMode: 'HALF_EVEN',
      },
    })).rejects.toThrow()
  })

  it('locks every economic and audit field on an active policy, field by field', async () => {
    await prisma.assetDefinition.upsert({
      where: { code: 'RP2' },
      update: {},
      create: { code: 'RP2', kind: 'reward_point', scale: 0, enabled: true },
    })
    const policy = await createTestCnyValuePolicy({
      id: 'vp_field_lock',
      version: 9501,
    })

    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { referenceAtomicPerPointNumerator: 2n },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { referenceAtomicPerPointDenominator: 2n },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { pointAssetCode: 'RP2' },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { version: 9502 },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { effectiveAt: new Date('2021-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { approvedAt: new Date('2021-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { activatedAt: new Date('2021-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { createdAt: new Date('2021-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { retiredAt: new Date('2021-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
  })

  it('allows only a controlled active-to-retired transition with a valid retiredAt', async () => {
    const policy = await createTestCnyValuePolicy({
      id: 'vp_retire',
      version: 9601,
    })

    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { status: 'retired' },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { status: 'retired', retiredAt: new Date('2019-01-01T00:00:00.000Z') },
    })).rejects.toThrow()

    const retired = await prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { status: 'retired', retiredAt: new Date() },
    })
    expect(retired.status).toBe('retired')

    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { referenceAtomicPerPointNumerator: 3n },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { effectiveAt: new Date('2022-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { retiredAt: new Date('2022-01-01T00:00:00.000Z') },
    })).rejects.toThrow()
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: { status: 'active', retiredAt: null },
    })).rejects.toThrow()
  })

  it('rejects contradictory pricing snapshots and unknown asset codes', async () => {
    const user = await prisma.user.create({
      data: { email: 'vp-snap-cons@test.local', password: 'x' },
    })
    const product = await prisma.product.create({
      data: { name: '快照一致性商品', type: '充值卡密', price: 100, categoryId: await getActiveCategoryIdByLabel('充值卡密') },
    })
    const order = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 100 },
    })
    const policy = await createTestCnyValuePolicy({
      id: 'vp_snap_cons',
      version: 9701,
      numerator: 1n,
      denominator: 2n,
    })

    await expect(prisma.orderPricingSnapshot.create({
      data: {
        orderId: order.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 99n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 50n,
        roundingMode: 'HALF_EVEN',
      },
    })).rejects.toThrow()

    await seedUsdAsset()
    await expect(prisma.orderPricingSnapshot.create({
      data: {
        orderId: order.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'USD',
        referenceAmountAtomic: 50n,
        roundingMode: 'HALF_EVEN',
      },
    })).rejects.toThrow()

    await expect(prisma.orderPricingSnapshot.create({
      data: {
        orderId: order.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 1n,
        roundingMode: 'HALF_EVEN',
      },
    })).rejects.toThrow()

    const ok = await prisma.orderPricingSnapshot.create({
      data: {
        orderId: order.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 50n,
        roundingMode: 'HALF_EVEN',
      },
    })
    expect(ok.referenceAmountAtomic).toBe(50n)
  })

  it('freezes RP/CNY identity and referenced asset kind/scale', async () => {
    await expect(prisma.assetDefinition.update({
      where: { code: 'RP' },
      data: { scale: 1 },
    })).rejects.toThrow()
    await expect(prisma.assetDefinition.update({
      where: { code: 'CNY' },
      data: { scale: 0 },
    })).rejects.toThrow()
    await expect(prisma.assetDefinition.update({
      where: { code: 'RP' },
      data: { kind: 'fiat' },
    })).rejects.toThrow()

    await prisma.valuePolicy.create({
      data: {
        id: 'vp_asset_lock',
        version: 9801,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'draft',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })
    await expect(prisma.assetDefinition.update({
      where: { code: 'CNY' },
      data: { scale: 3 },
    })).rejects.toThrow()
  })

  it('rejects an active policy bound to a disabled or retired asset', async () => {
    await prisma.assetDefinition.upsert({
      where: { code: 'RP_DISABLED' },
      update: { enabled: false, retiredAt: null },
      create: { code: 'RP_DISABLED', kind: 'reward_point', scale: 0, enabled: false },
    })
    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_disabled_asset',
        version: 9901,
        pointAssetCode: 'RP_DISABLED',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'active',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })).rejects.toThrow()

    await createTestCnyValuePolicy({
      id: 'vp_live_asset',
      version: 9902,
    })
    await expect(prisma.assetDefinition.update({
      where: { code: 'CNY' },
      data: { enabled: false },
    })).rejects.toThrow()
    await expect(prisma.assetDefinition.update({
      where: { code: 'RP' },
      data: { retiredAt: new Date() },
    })).rejects.toThrow()
  })

  it('rejects inserting retired and retiring from draft, approved, or scheduled', async () => {
    const retiredAt = new Date()

    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_insert_retired',
        version: 10001,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'retired',
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
        retiredAt,
      },
    })).rejects.toThrow(/value_policy_retire_requires_active/)

    for (const [status, version] of [
      ['draft', 10002],
      ['approved', 10003],
      ['scheduled', 10004],
    ] as const) {
      const policy = await createTestCnyValuePolicy({
        id: `vp_retire_from_${status}`,
        version,
        status,
      })
      await expect(prisma.valuePolicy.update({
        where: { id: policy.id },
        data: { status: 'retired', retiredAt },
      })).rejects.toThrow(/value_policy_retire_requires_active/)
    }
  })

  it('matches TypeScript HALF_EVEN conversion in PostgreSQL, including INT8 overflow rejection', async () => {
    for (const vector of HALF_EVEN_VECTORS) {
      const ts = convertPointsToReferenceAtomic({
        pointsAtomic: vector.pointsAtomic,
        referenceAtomicPerPointNumerator: vector.numerator,
        referenceAtomicPerPointDenominator: vector.denominator,
        roundingMode: 'HALF_EVEN',
      })
      expect(ts, `ts:${vector.name}`).toBe(vector.expected)

      const rows = await prisma.$queryRaw<Array<{ result: bigint }>>`
        SELECT convert_points_to_reference_atomic(
          ${vector.pointsAtomic},
          ${vector.numerator},
          ${vector.denominator},
          'HALF_EVEN'::"MoneyRoundingMode"
        ) AS result
      `
      expect(BigInt(rows[0]!.result), `pg:${vector.name}`).toBe(vector.expected)
      expect(BigInt(rows[0]!.result), `pg-ts:${vector.name}`).toBe(ts)
    }

    const overflowTs = convertPointsToReferenceAtomic({
      pointsAtomic: HALF_EVEN_OVERFLOW_VECTOR.pointsAtomic,
      referenceAtomicPerPointNumerator: HALF_EVEN_OVERFLOW_VECTOR.numerator,
      referenceAtomicPerPointDenominator: HALF_EVEN_OVERFLOW_VECTOR.denominator,
      roundingMode: 'HALF_EVEN',
    })
    expect(overflowTs > PG_INT8_MAX).toBe(true)

    await expect(prisma.$queryRaw`
      SELECT convert_points_to_reference_atomic(
        ${HALF_EVEN_OVERFLOW_VECTOR.pointsAtomic},
        ${HALF_EVEN_OVERFLOW_VECTOR.numerator},
        ${HALF_EVEN_OVERFLOW_VECTOR.denominator},
        'HALF_EVEN'::"MoneyRoundingMode"
      ) AS result
    `).rejects.toThrow(/reference_amount_overflows_int8|22003/)
  })

  it('accepts HALF_EVEN snapshot amounts that hit rounding branches', async () => {
    const user = await prisma.user.create({
      data: { email: 'vp-he-snap@test.local', password: 'x' },
    })
    const cases = [
      { suffix: 'even_tie', price: 1, num: 1n, den: 2n, expected: 0n },
      { suffix: 'odd_tie', price: 3, num: 1n, den: 2n, expected: 2n },
      { suffix: 'down', price: 10, num: 1n, den: 3n, expected: 3n },
      { suffix: 'up', price: 11, num: 1n, den: 3n, expected: 4n },
    ] as const

    for (const [index, item] of cases.entries()) {
      const pointCode = `RP_HE_${item.suffix}`
      await prisma.assetDefinition.upsert({
        where: { code: pointCode },
        update: { enabled: true, retiredAt: null },
        create: { code: pointCode, kind: 'reward_point', scale: 0, enabled: true },
      })
      const product = await prisma.product.create({
        data: {
          name: `舍入快照商品${item.suffix}`,
          type: '充值卡密',
          price: item.price,
          categoryId: await getActiveCategoryIdByLabel('充值卡密'),
        },
      })
      const order = await prisma.order.create({
        data: { userId: user.id, productId: product.id, price: item.price },
      })
      const policy = await createTestCnyValuePolicy({
        id: `vp_he_${item.suffix}`,
        version: 10101 + index,
        pointAssetCode: pointCode,
        numerator: item.num,
        denominator: item.den,
      })

      const ts = convertPointsToReferenceAtomic({
        pointsAtomic: BigInt(item.price),
        referenceAtomicPerPointNumerator: item.num,
        referenceAtomicPerPointDenominator: item.den,
        roundingMode: 'HALF_EVEN',
      })
      expect(ts, item.suffix).toBe(item.expected)

      await expect(prisma.orderPricingSnapshot.create({
        data: {
          orderId: order.id,
          pointsAssetCode: pointCode,
          pointsAmountAtomic: BigInt(item.price),
          valuePolicyId: policy.id,
          referenceAssetCode: 'CNY',
          referenceAmountAtomic: item.expected + 1n,
          roundingMode: 'HALF_EVEN',
        },
      })).rejects.toThrow(/order_pricing_snapshot_reference_mismatch/)

      const ok = await prisma.orderPricingSnapshot.create({
        data: {
          orderId: order.id,
          pointsAssetCode: pointCode,
          pointsAmountAtomic: BigInt(item.price),
          valuePolicyId: policy.id,
          referenceAssetCode: 'CNY',
          referenceAmountAtomic: item.expected,
          roundingMode: 'HALF_EVEN',
        },
      })
      expect(ok.referenceAmountAtomic).toBe(item.expected)
    }
  })

  it('rejects snapshots against non-active policies and keeps historical snapshots after retire', async () => {
    const user = await prisma.user.create({
      data: { email: 'vp-snap-active@test.local', password: 'x' },
    })
    const product = await prisma.product.create({
      data: {
        name: '非激活快照商品',
        type: '充值卡密',
        price: 100,
        categoryId: await getActiveCategoryIdByLabel('充值卡密'),
      },
    })

    for (const [index, status] of (['draft', 'approved', 'scheduled'] as const).entries()) {
      const order = await prisma.order.create({
        data: { userId: user.id, productId: product.id, price: 100 },
      })
      const policy = await createTestCnyValuePolicy({
        id: `vp_snap_${status}`,
        version: 10201 + index,
        status,
      })
      await expect(prisma.orderPricingSnapshot.create({
        data: {
          orderId: order.id,
          pointsAssetCode: 'RP',
          pointsAmountAtomic: 100n,
          valuePolicyId: policy.id,
          referenceAssetCode: 'CNY',
          referenceAmountAtomic: 100n,
          roundingMode: 'HALF_EVEN',
        },
      })).rejects.toThrow(/order_pricing_snapshot_policy_not_active/)
    }

    const liveOrder = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 100 },
    })
    const livePolicy = await createTestCnyValuePolicy({
      id: 'vp_snap_then_retire',
      version: 10210,
    })
    const snapshot = await prisma.orderPricingSnapshot.create({
      data: {
        orderId: liveOrder.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: livePolicy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 100n,
        roundingMode: 'HALF_EVEN',
      },
    })

    const retired = await prisma.valuePolicy.update({
      where: { id: livePolicy.id },
      data: { status: 'retired', retiredAt: new Date() },
    })
    expect(retired.status).toBe('retired')

    const kept = await prisma.orderPricingSnapshot.findUniqueOrThrow({
      where: { orderId: snapshot.orderId },
    })
    expect(kept.referenceAmountAtomic).toBe(100n)
    expect(kept.valuePolicyId).toBe(livePolicy.id)

    const laterOrder = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 100 },
    })
    await expect(prisma.orderPricingSnapshot.create({
      data: {
        orderId: laterOrder.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: livePolicy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 100n,
        roundingMode: 'HALF_EVEN',
      },
    })).rejects.toThrow(/order_pricing_snapshot_policy_not_active/)
  })
})
