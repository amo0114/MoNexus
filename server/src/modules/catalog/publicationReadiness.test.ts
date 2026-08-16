// T-CAT-BE-003 — publicationReadiness pure unit tests
// (SPEC-CATALOG-OPS-001 §6.1; D-CAT-03/D-CAT-22; CHK-PROD-003/004;
// AC-CAT-002/003). No DB access — db client is injected and mocked.
// Safe to run in any harness.

import { describe, expect, it, vi } from 'vitest'
import { checkProductReadiness, type ReadinessDetail } from './publicationReadiness.js'
import { CATEGORY_STATUS, READINESS_DETAIL_CODES } from './constants.js'

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
    _count: { inventory: overrides.available ?? 0 },
  }
}

type ProductOverrides = Partial<{
  id: number
  name: string
  imageUrl: string | null
  images: string[]
  merchantId: number | null
  status: string
  publishedAt: Date | null
  categoryStatus: string
  offers: ReturnType<typeof offer>[]
}>

function product(overrides: ProductOverrides = {}) {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? '测试商品',
    imageUrl: overrides.imageUrl ?? '/uploads/cover.webp',
    images: overrides.images ?? ['/uploads/cover.webp'],
    merchantId: overrides.merchantId ?? null,
    status: overrides.status ?? 'draft',
    publishedAt: overrides.publishedAt ?? null,
    category: { id: 1, status: overrides.categoryStatus ?? CATEGORY_STATUS.ACTIVE },
    offers: overrides.offers ?? [offer({ available: 3 })],
  }
}

function makeDb(row: ReturnType<typeof product> | null, webhookCount = 0) {
  return {
    product: {
      findUnique: vi.fn(async () => row),
    },
    merchantWebhookConfig: {
      count: vi.fn(async () => webhookCount),
    },
  }
}

const codes = (details: ReadinessDetail[]) => details.map(d => d.code)

describe('checkProductReadiness — ready', () => {
  it('is ready for a complete draft with cover, active category and a sellable offer', async () => {
    const db = makeDb(product())
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(true)
    expect(result.isFirstPublish).toBe(true)
    expect(result.details).toEqual([])
  })

  it('is ready for a complete draft with any sellable delivery mode', async () => {
    const cases: ReturnType<typeof offer>[] = [
      offer({ deliveryMode: 'instant_inventory', available: 1 }),
      offer({ deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContent: 'x' }),
      offer({ deliveryMode: 'instant_fixed', stockMode: 'limited', stock: 5, fixedContent: 'x' }),
      offer({ deliveryMode: 'instant_fixed', fixedContentType: 'file', fixedFileId: 9, stockMode: 'unlimited' }),
      offer({ deliveryMode: 'manual_service', stockMode: 'unlimited' }),
      offer({ deliveryMode: 'manual_service', stockMode: 'limited', stock: 2 }),
    ]
    for (const o of cases) {
      const db = makeDb(product({ offers: [o] }))
      const result = await checkProductReadiness(1, db as never)
      expect(result.ready).toBe(true)
    }
  })

  it('is ready when one active offer is sellable even if another active offer is empty but config-valid', async () => {
    const db = makeDb(product({
      offers: [
        offer({ id: 1, deliveryMode: 'instant_fixed', stockMode: 'limited', stock: 5, fixedContent: 'x' }),
        offer({ id: 2, deliveryMode: 'manual_service', stockMode: 'limited', stock: 0 }),
      ],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(true)
    expect(result.details).toEqual([])
  })

  it('allows an inactive category on republish (publishedAt already set) — D-CAT-22', async () => {
    const db = makeDb(product({
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      categoryStatus: CATEGORY_STATUS.INACTIVE,
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.isFirstPublish).toBe(false)
    expect(result.ready).toBe(true)
  })

  it('is ready for a Faka offer when provider is configured and sku present', async () => {
    const db = makeDb(product({
      offers: [offer({
        deliveryMode: 'manual_service', stockMode: 'unlimited',
        externalIntegration: 'faka_bridge', externalSku: 'plan-3-half_yearly',
      })],
    }))
    const result = await checkProductReadiness(1, db as never, { isProviderConfigured: () => true })
    expect(result.ready).toBe(true)
  })

  it('is ready for an auto-provision manual offer when an active webhook exists', async () => {
    const db = makeDb(product({
      merchantId: 7,
      offers: [offer({ deliveryMode: 'manual_service', stockMode: 'unlimited', autoProvision: true })],
    }), 1)
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(true)
  })
})

describe('checkProductReadiness — cover (COVER_REQUIRED)', () => {
  it('fails with a stable COVER_REQUIRED code when no cover is set', async () => {
    const db = makeDb(product({ imageUrl: null, images: [] }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toEqual([READINESS_DETAIL_CODES.COVER_REQUIRED])
    expect(result.details[0]).toMatchObject({ code: 'COVER_REQUIRED', field: 'images', offerId: null })
  })

  it('fails when images[0] differs from the canonical imageUrl', async () => {
    const db = makeDb(product({
      imageUrl: '/uploads/a.webp',
      images: ['/uploads/b.webp'],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.COVER_REQUIRED)
  })

  it('fails when only imageUrl or only images is present', async () => {
    const onlyUrl = await checkProductReadiness(1, makeDb(product({ imageUrl: '/uploads/a.webp', images: [] })) as never)
    expect(onlyUrl.ready).toBe(false)
    const onlyImages = await checkProductReadiness(1, makeDb(product({ imageUrl: null, images: ['/uploads/a.webp'] })) as never)
    expect(onlyImages.ready).toBe(false)
  })
})

describe('checkProductReadiness — category (CATEGORY_INACTIVE)', () => {
  it('fails with a stable CATEGORY_INACTIVE code on first publish into an inactive category', async () => {
    const db = makeDb(product({ categoryStatus: CATEGORY_STATUS.INACTIVE }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.CATEGORY_INACTIVE)
    const categoryDetail = result.details.find(d => d.code === READINESS_DETAIL_CODES.CATEGORY_INACTIVE)
    expect(categoryDetail).toMatchObject({ field: 'category', offerId: null })
  })
})

describe('checkProductReadiness — offers (OFFER_NOT_SELLABLE)', () => {
  it('fails with OFFER_NOT_SELLABLE and offerId null when there are no active offers', async () => {
    const db = makeDb(product({
      offers: [offer({ status: 'inactive' })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    const detail = result.details.find(d => d.code === READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)
    expect(detail).toMatchObject({ code: 'OFFER_NOT_SELLABLE', field: 'offers', offerId: null })
  })

  it('fails when every active offer is out of stock / has no available inventory', async () => {
    const db = makeDb(product({
      offers: [
        offer({ id: 11, deliveryMode: 'instant_inventory', available: 0 }),
        offer({ id: 12, deliveryMode: 'instant_fixed', stockMode: 'limited', stock: 0, fixedContent: 'x' }),
      ],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    const notSellable = result.details.filter(d => d.code === READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)
    expect(notSellable.length).toBeGreaterThan(0)
    expect(notSellable.map(d => d.offerId)).toEqual(expect.arrayContaining([11, 12]))
  })

  it('fails for instant_fixed missing fixed content', async () => {
    const db = makeDb(product({
      offers: [offer({ id: 21, deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContent: null })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)
  })

  it('fails for file-form instant_fixed without a fixed file', async () => {
    const db = makeDb(product({
      offers: [offer({ id: 22, deliveryMode: 'instant_fixed', fixedContentType: 'file', fixedFileId: null, stockMode: 'unlimited' })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)
  })

  it('fails for auto-provision manual offer without an active webhook', async () => {
    const db = makeDb(product({
      merchantId: 7,
      offers: [offer({ id: 23, deliveryMode: 'manual_service', stockMode: 'unlimited', autoProvision: true })],
    }), 0)
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toContain(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)
  })
})

describe('checkProductReadiness — external identity (EXTERNAL_IDENTITY_INVALID)', () => {
  it('fails with a stable EXTERNAL_IDENTITY_INVALID code when the Faka provider is not configured', async () => {
    const db = makeDb(product({
      offers: [offer({
        deliveryMode: 'manual_service', stockMode: 'unlimited',
        externalIntegration: 'faka_bridge', externalSku: 'aster-basic-monthly',
      })],
    }))
    const result = await checkProductReadiness(1, db as never, { isProviderConfigured: () => false })
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toEqual([READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID])
    const detail = result.details[0]
    expect(detail).toMatchObject({ code: 'EXTERNAL_IDENTITY_INVALID', field: 'offers', offerId: 1 })
  })

  it('fails when a Faka offer is missing its externalSku', async () => {
    const db = makeDb(product({
      offers: [offer({
        deliveryMode: 'manual_service', stockMode: 'unlimited',
        externalIntegration: 'faka_bridge', externalSku: null,
      })],
    }))
    const result = await checkProductReadiness(1, db as never, { isProviderConfigured: () => true })
    expect(result.ready).toBe(false)
    expect(codes(result.details)).toEqual([READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID])
  })
})

describe('checkProductReadiness — aggregate + not found', () => {
  it('collects every missing condition at once with stable codes', async () => {
    const db = makeDb(product({
      imageUrl: null,
      images: [],
      categoryStatus: CATEGORY_STATUS.INACTIVE,
      offers: [offer({ deliveryMode: 'instant_inventory', available: 0 })],
    }))
    const result = await checkProductReadiness(1, db as never)
    expect(result.ready).toBe(false)
    expect(codes(result.details).sort()).toEqual(
      [
        READINESS_DETAIL_CODES.COVER_REQUIRED,
        READINESS_DETAIL_CODES.CATEGORY_INACTIVE,
        READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE,
      ].sort(),
    )
  })

  it('throws notFound for an unknown product', async () => {
    const db = makeDb(null)
    await expect(checkProductReadiness(999, db as never)).rejects.toMatchObject({ status: 404 })
  })

  it('never performs remote I/O: only findUnique/count on the injected client are called', async () => {
    const db = makeDb(product(), 1)
    await checkProductReadiness(1, db as never)
    expect(db.product.findUnique).toHaveBeenCalledTimes(1)
    // No webhook query when no auto-provision offer exists.
    expect(db.merchantWebhookConfig.count).not.toHaveBeenCalled()
  })
})
