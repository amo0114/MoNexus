// SPEC-PRODUCT-COMMERCE-002 §5.3 / §12.1 — templated publish readiness.
// Pure unit tests; db client is injected and mocked (no PostgreSQL).

import { describe, expect, it, vi } from 'vitest'
import { checkProductReadiness, type ReadinessDetail } from './publicationReadiness.js'
import { CATEGORY_STATUS, READINESS_DETAIL_CODES } from './constants.js'
import { EMPTY_PRODUCT_DETAILS } from './templates/types.js'

type OfferOverrides = Partial<{
  id: number
  status: string
  deliveryMode: string
  stockMode: string
  stock: number
  fixedContent: string | null
  fixedContentType: string
  fixedFileId: number | null
  autoProvision: boolean
  externalIntegration: string | null
  externalSku: string | null
  attributes: Record<string, unknown>
  deliveryFields: unknown
  fixedStructuredContent: unknown
  available: number
}>

function offer(overrides: OfferOverrides = {}) {
  return {
    id: overrides.id ?? 1,
    status: overrides.status ?? 'active',
    deliveryMode: overrides.deliveryMode ?? 'instant_inventory',
    stockMode: overrides.stockMode ?? 'limited',
    stock: overrides.stock ?? 0,
    fixedContent: overrides.fixedContent ?? null,
    fixedContentType: overrides.fixedContentType ?? 'text',
    fixedFileId: overrides.fixedFileId ?? null,
    autoProvision: overrides.autoProvision ?? false,
    externalIntegration: overrides.externalIntegration ?? null,
    externalSku: overrides.externalSku ?? null,
    attributes: overrides.attributes ?? {},
    deliveryFields: overrides.deliveryFields ?? null,
    fixedStructuredContent: overrides.fixedStructuredContent ?? null,
    _count: { inventory: overrides.available ?? 0 },
  }
}

const publishDetails = {
  ...EMPTY_PRODUCT_DETAILS,
  purchaseNotes: '购买前请确认适用地区与兑换方式。',
  afterSalesInstructions: '订单问题请提交售后工单。',
}

type ProductOverrides = Partial<{
  imageUrl: string | null
  images: string[]
  publishedAt: Date | null
  categoryStatus: string
  templateKey: string | null
  templateVersion: number | null
  attributes: Record<string, unknown>
  details: Record<string, unknown>
  purchaseForm: unknown
  offers: ReturnType<typeof offer>[]
}>

function product(overrides: ProductOverrides = {}) {
  return {
    id: 1,
    name: '测试商品',
    imageUrl: overrides.imageUrl ?? '/uploads/cover.webp',
    images: overrides.images ?? ['/uploads/cover.webp'],
    merchantId: null,
    status: 'draft',
    publishedAt: overrides.publishedAt ?? null,
    templateKey: overrides.templateKey ?? null,
    templateVersion: overrides.templateVersion ?? null,
    attributes: overrides.attributes ?? {},
    details: overrides.details ?? { ...EMPTY_PRODUCT_DETAILS },
    purchaseForm: overrides.purchaseForm ?? [],
    category: { id: 1, status: overrides.categoryStatus ?? CATEGORY_STATUS.ACTIVE },
    offers: overrides.offers ?? [offer({ available: 3 })],
  }
}

function makeDb(row: ReturnType<typeof product> | null) {
  return {
    product: {
      findUnique: vi.fn(async () => row),
    },
    merchantWebhookConfig: {
      count: vi.fn(async () => 0),
    },
  }
}

const codes = (details: ReadinessDetail[]) => details.map(d => d.code)

describe('checkProductReadiness — templated products', () => {
  it('fails with TEMPLATE_FIELDS_REQUIRED when a required product attribute is missing', async () => {
    const db = makeDb(product({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: { region: '全球' },
      details: publishDetails,
      offers: [offer({
        available: 3,
        attributes: { unitLabel: '1 个兑换码' },
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.TEMPLATE_FIELDS_REQUIRED)
    expect(result.details.find(d => d.code === READINESS_DETAIL_CODES.TEMPLATE_FIELDS_REQUIRED))
      .toMatchObject({ field: '/attributes', offerId: null })
  })

  it('is not ready when an appointment is missing a required date purchaseForm field', async () => {
    const db = makeDb(product({
      templateKey: 'appointment',
      templateVersion: 1,
      attributes: { deliveryChannel: 'video', timeZone: 'Asia/Shanghai' },
      details: publishDetails,
      purchaseForm: [{ key: 'note', type: 'text', required: true }],
      offers: [offer({
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        attributes: { servicePackage: '一次在线咨询' },
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.FULFILLMENT_CONFIG_INVALID)
    expect(result.details.find(d => d.code === READINESS_DETAIL_CODES.FULFILLMENT_CONFIG_INVALID))
      .toMatchObject({ field: 'offers', offerId: 1 })
  })

  it('is not ready when a shared-account offer is missing fixedStructuredContent', async () => {
    const db = makeDb(product({
      templateKey: 'account',
      templateVersion: 1,
      attributes: {
        serviceName: '示例服务',
        accessModel: 'shared',
        usageRestrictions: '按商家约定使用，请勿修改账号资料。',
      },
      details: publishDetails,
      offers: [offer({
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'user: demo',
        attributes: { accountTier: '基础功能' },
        fixedStructuredContent: null,
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.FULFILLMENT_CONFIG_INVALID)
    expect(result.details.find(d => d.code === READINESS_DETAIL_CODES.FULFILLMENT_CONFIG_INVALID))
      .toMatchObject({ offerId: 1 })
  })

  it('requires purchaseNotes and afterSalesInstructions on templated publish', async () => {
    const db = makeDb(product({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: {
        serviceName: '示例软件',
        redemptionMethod: '在软件的兑换入口输入卡密。',
      },
      details: EMPTY_PRODUCT_DETAILS,
      offers: [offer({
        available: 3,
        attributes: { unitLabel: '1 个兑换码' },
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toEqual(expect.arrayContaining([
      READINESS_DETAIL_CODES.PURCHASE_NOTES_REQUIRED,
      READINESS_DETAIL_CODES.AFTER_SALES_REQUIRED,
    ]))
  })

  it('is ready for a complete templated redemption_code draft', async () => {
    const db = makeDb(product({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: {
        serviceName: '示例软件',
        region: '全球',
        redemptionMethod: '在软件的兑换入口输入卡密。',
      },
      details: publishDetails,
      offers: [offer({
        available: 3,
        attributes: { unitLabel: '1 个兑换码' },
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(true)
    expect(result.details).toEqual([])
  })

  it('is ready for a shared-account offer with structured fixed content', async () => {
    const db = makeDb(product({
      templateKey: 'account',
      templateVersion: 1,
      attributes: {
        serviceName: '示例服务',
        accessModel: 'shared',
        usageRestrictions: '按商家约定使用，请勿修改账号资料。',
      },
      details: publishDetails,
      offers: [offer({
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'user: demo',
        attributes: { accountTier: '基础功能' },
        fixedStructuredContent: {
          fields: [{ key: 'user', label: '账号', sensitive: false }],
          values: { user: 'demo' },
        },
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(true)
  })

  it('is ready for an appointment with a required date purchaseForm field', async () => {
    const db = makeDb(product({
      templateKey: 'appointment',
      templateVersion: 1,
      attributes: { deliveryChannel: 'video', timeZone: 'Asia/Shanghai' },
      details: publishDetails,
      purchaseForm: [{ key: 'bookingDate', type: 'date', required: true }],
      offers: [offer({
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        attributes: { servicePackage: '一次在线咨询' },
      })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(true)
  })
})

describe('checkProductReadiness — legacy products without a template', () => {
  it('still uses the old cover/offer rules and does not invent a template', async () => {
    const missingCover = await checkProductReadiness(1, makeDb(product({
      templateKey: null,
      templateVersion: null,
      imageUrl: null,
      images: [],
    })) as never)
    expect(missingCover.ready).toBe(false)
    expect(codes(missingCover.details)).toEqual([READINESS_DETAIL_CODES.COVER_REQUIRED])
    expect(codes(missingCover.details)).not.toContain(READINESS_DETAIL_CODES.TEMPLATE_FIELDS_REQUIRED)
    expect(codes(missingCover.details)).not.toContain(READINESS_DETAIL_CODES.PURCHASE_NOTES_REQUIRED)
    expect(codes(missingCover.details)).not.toContain(READINESS_DETAIL_CODES.AFTER_SALES_REQUIRED)

    const sellableLegacy = await checkProductReadiness(1, makeDb(product({
      templateKey: null,
      templateVersion: null,
      details: EMPTY_PRODUCT_DETAILS,
    })) as never)
    expect(sellableLegacy.ready).toBe(true)
    expect(sellableLegacy.details).toEqual([])
  })
})
