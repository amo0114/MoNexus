import { describe, expect, it } from 'vitest'
import { HttpError } from '../lib/httpError.js'
import {
  FAKA_EXTERNAL_INTEGRATION,
  isFakaBridgeOffer,
  normalizeFakaOfferIntegration,
} from '../lib/fakaBridge/offerIntegration.js'
import { computeOfferCheckoutVersion } from '../lib/offers.js'
import { prisma } from '../lib/prisma.js'
import { createTestUser } from './helpers.js'

describe('normalizeFakaOfferIntegration', () => {
  it('clears both fields when unset', () => {
    expect(normalizeFakaOfferIntegration({})).toEqual({
      externalIntegration: null,
      externalSku: null,
    })
  })

  it('normalizes faka_bridge + sku', () => {
    const result = normalizeFakaOfferIntegration(
      {
        externalIntegration: 'Faka_Bridge',
        externalSku: 'Aster-Basic-Monthly',
        deliveryMode: 'manual_service',
      },
      { requireConfigured: false }
    )
    expect(result).toEqual({
      externalIntegration: FAKA_EXTERNAL_INTEGRATION,
      externalSku: 'aster-basic-monthly',
    })
  })

  it('rejects orphan externalSku', () => {
    expect(() =>
      normalizeFakaOfferIntegration({ externalSku: 'aster-basic-monthly' }, { requireConfigured: false })
    ).toThrow(HttpError)
  })

  it('rejects unknown integration', () => {
    expect(() =>
      normalizeFakaOfferIntegration(
        { externalIntegration: 'stripe', externalSku: 'x' },
        { requireConfigured: false }
      )
    ).toThrow(/不支持的 externalIntegration/)
  })

  it('rejects faka_bridge without sku', () => {
    expect(() =>
      normalizeFakaOfferIntegration(
        { externalIntegration: 'faka_bridge', deliveryMode: 'manual_service' },
        { requireConfigured: false }
      )
    ).toThrow(/externalSku/)
  })

  it('rejects invalid sku characters', () => {
    expect(() =>
      normalizeFakaOfferIntegration(
        {
          externalIntegration: 'faka_bridge',
          externalSku: 'Aster Basic!',
          deliveryMode: 'manual_service',
        },
        { requireConfigured: false }
      )
    ).toThrow(/格式无效/)
  })

  it('rejects non-manual_service delivery mode', () => {
    expect(() =>
      normalizeFakaOfferIntegration(
        {
          externalIntegration: 'faka_bridge',
          externalSku: 'aster-basic-monthly',
          deliveryMode: 'instant_fixed',
        },
        { requireConfigured: false }
      )
    ).toThrow(/manual_service/)
  })

  it('rejects when platform env is not configured (default)', () => {
    // vitest env has no FAKA_BRIDGE_* → isFakaBridgeConfigured() false
    expect(() =>
      normalizeFakaOfferIntegration({
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-monthly',
        deliveryMode: 'manual_service',
      })
    ).toThrow(/未配置 FakaBridge/)
  })
})

describe('isFakaBridgeOffer', () => {
  it('detects integration flag', () => {
    expect(isFakaBridgeOffer({ externalIntegration: 'faka_bridge' })).toBe(true)
    expect(isFakaBridgeOffer({ externalIntegration: null })).toBe(false)
  })
})

describe('computeOfferCheckoutVersion includes faka fields', () => {
  const base = {
    price: 100,
    status: 'active',
    deliveryMode: 'manual_service',
    stockMode: 'unlimited',
    fixedContent: null,
    fixedContentType: 'text',
    deliveryFields: null,
    fixedFileId: null,
    validityDays: 30,
    externalIntegration: null as string | null,
    externalSku: null as string | null,
  }

  it('keeps legacy hash when integration is null', () => {
    const a = computeOfferCheckoutVersion(base as any)
    const b = computeOfferCheckoutVersion({ ...base, externalSku: null } as any)
    expect(a).toBe(b)
  })

  it('changes when externalSku is set under faka_bridge', () => {
    const plain = computeOfferCheckoutVersion(base as any)
    const withFaka = computeOfferCheckoutVersion({
      ...base,
      externalIntegration: 'faka_bridge',
      externalSku: 'aster-basic-monthly',
    } as any)
    const otherSku = computeOfferCheckoutVersion({
      ...base,
      externalIntegration: 'faka_bridge',
      externalSku: 'aster-pro-monthly',
    } as any)
    expect(withFaka).not.toBe(plain)
    expect(otherSku).not.toBe(withFaka)
  })
})

describe('FakaBridgeTask prisma model', () => {
  it('creates a task row linked to an order with frozen snapshots', async () => {
    const email = `faka-m2-${Date.now()}@example.com`
    const { user } = await createTestUser(email)
    const product = await prisma.product.create({
      data: {
        name: 'Xboard 测试',
        type: '网络节点',
        price: 100,
        stock: 0,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    const offer = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '月卡',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        isDefault: true,
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-monthly',
      },
    })
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        offerId: offer.id,
        price: 100,
        status: 'pending',
        deliveryModeSnapshot: 'manual_service',
        holdingPoints: 100,
        fundsHeld: true,
      },
    })

    const task = await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: user.email,
        skuSnapshot: 'aster-basic-monthly',
        periodSnapshot: 'monthly',
        maxAttempts: 3,
      },
    })

    expect(task.status).toBe('pending')
    expect(task.requestOrderNo).toBe(`MN-${order.id}`)
    expect(task.emailSnapshot).toBe(email)
    expect(task.skuSnapshot).toBe('aster-basic-monthly')

    const again = await prisma.fakaBridgeTask.findUnique({ where: { orderId: order.id } })
    expect(again?.id).toBe(task.id)
  })

  it('rejects faka_bridge offer without externalSku at DB level', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'bad offer product',
        type: '网络节点',
        price: 50,
        stock: 0,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    await expect(
      prisma.offer.create({
        data: {
          productId: product.id,
          name: '坏规格',
          price: 50,
          deliveryMode: 'manual_service',
          stockMode: 'unlimited',
          externalIntegration: 'faka_bridge',
          externalSku: null,
        },
      })
    ).rejects.toThrow()
  })
})
