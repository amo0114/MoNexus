import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __clearFakaCapacityCacheForTests,
  __setFakaCapacityProbeForTests,
  fetchFakaCapacityForSku,
  getFakaCapacityForPublicRead,
  prewarmFakaCapacityForSkus,
  type FakaCapacitySnapshot,
} from '../lib/fakaBridge/capacity.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

function snapshot(sku: string, remaining = 7): FakaCapacitySnapshot {
  return {
    sku,
    planId: 42,
    capacityLimit: 10,
    activeUsers: 10 - remaining,
    remaining,
    sellable: remaining > 0,
    source: 'xboard',
  }
}

function unavailableSnapshot(sku: string): FakaCapacitySnapshot {
  return {
    sku,
    planId: null,
    capacityLimit: null,
    activeUsers: null,
    remaining: null,
    sellable: true,
    source: 'unavailable',
    reason: '暂时无法确认 Xboard 套餐名额',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function finishesWithin<T>(promise: PromiseLike<T>, ms = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`request unexpectedly waited more than ${ms}ms for Faka capacity`)),
      ms
    )
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

describe('Faka capacity public-read cache', () => {
  beforeEach(() => {
    __clearFakaCapacityCacheForTests()
  })

  afterEach(() => {
    __clearFakaCapacityCacheForTests()
    vi.restoreAllMocks()
  })

  it('returns a cold-cache fallback immediately while one background probe warms it', async () => {
    const pending = deferred<FakaCapacitySnapshot>()
    const probe = vi.fn(() => pending.promise)
    __setFakaCapacityProbeForTests(probe)

    // A public request must never await a slow Xboard response.
    expect(getFakaCapacityForPublicRead('Aster-Basic')).toMatchObject({
      sku: 'aster-basic',
      source: 'unavailable',
      sellable: true,
    })
    expect(getFakaCapacityForPublicRead('aster-basic')).toMatchObject({
      source: 'unavailable',
    })
    expect(probe).toHaveBeenCalledTimes(1)

    pending.resolve(snapshot('aster-basic', 4))
    await expect(fetchFakaCapacityForSku('aster-basic')).resolves.toMatchObject({
      source: 'xboard',
      remaining: 4,
    })
    expect(getFakaCapacityForPublicRead('aster-basic')).toMatchObject({
      source: 'xboard',
      remaining: 4,
    })
  })

  it('serves a bounded stale success while it refreshes in the background', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const probe = vi
      .fn<(sku: string) => Promise<FakaCapacitySnapshot>>()
      .mockResolvedValueOnce(snapshot('aster-basic', 4))
      .mockResolvedValueOnce(snapshot('aster-basic', 3))
    __setFakaCapacityProbeForTests(probe)

    await fetchFakaCapacityForSku('aster-basic')
    now += 45_001 // past the authoritative TTL, still inside the 5 min SWR window

    expect(getFakaCapacityForPublicRead('aster-basic')).toMatchObject({
      source: 'xboard',
      remaining: 4,
    })
    expect(probe).toHaveBeenCalledTimes(2)

    await expect(fetchFakaCapacityForSku('aster-basic')).resolves.toMatchObject({
      remaining: 3,
    })
    expect(getFakaCapacityForPublicRead('aster-basic')).toMatchObject({
      source: 'xboard',
      remaining: 3,
    })
  })

  it('keeps a bounded stale success visible through a transient refresh failure', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const probe = vi
      .fn<(sku: string) => Promise<FakaCapacitySnapshot>>()
      .mockResolvedValueOnce(snapshot('aster-basic', 4))
      .mockResolvedValueOnce(unavailableSnapshot('aster-basic'))
    __setFakaCapacityProbeForTests(probe)

    await fetchFakaCapacityForSku('aster-basic')
    now += 45_001

    // Checkout's authoritative read sees the short negative result, but that
    // result must not erase the previously useful storefront SWR snapshot.
    await expect(fetchFakaCapacityForSku('aster-basic')).resolves.toMatchObject({
      source: 'unavailable',
    })
    expect(getFakaCapacityForPublicRead('aster-basic')).toMatchObject({
      source: 'xboard',
      remaining: 4,
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('prewarms unique SKUs and reuses fresh cache entries on the next tick', async () => {
    const probe = vi.fn(async (sku: string) => snapshot(sku))
    __setFakaCapacityProbeForTests(probe)

    await expect(
      prewarmFakaCapacityForSkus([
        'Aster-Basic',
        'aster-basic',
        'aster-pro',
        'plan-42-monthly',
        'plan-42-quarterly',
        '  ',
      ])
    ).resolves.toBe(3)
    // The two plan-42 period aliases share one plan-level probe.
    expect(probe).toHaveBeenCalledTimes(3)
    expect(probe.mock.calls.map(([sku]) => sku).sort()).toEqual([
      'aster-basic',
      'aster-pro',
      'plan-42-monthly',
    ])

    await expect(
      prewarmFakaCapacityForSkus(['aster-pro', 'aster-basic', 'plan-42-quarterly'])
    ).resolves.toBe(3)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('keeps storefront list/detail and checkout preview off a slow Xboard request path', async () => {
    const originalConfig = { ...config.fakaBridge }
    Object.assign(config.fakaBridge, {
      enabled: true,
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      timeoutMs: 5_000,
      maxAttempts: 3,
      allowInsecureTargets: false,
    })

    const pending = deferred<FakaCapacitySnapshot>()
    const probe = vi.fn(() => pending.promise)
    __setFakaCapacityProbeForTests(probe)

    try {
      const product = await prisma.product.create({
        data: {
          name: '公共读容量测试',
          type: '网络节点',
          categoryId: await getActiveNetworkNodeCategoryId(),
          price: 100,
          stock: 0,
          status: 'active',
          deliveryMode: 'manual_service',
          stockMode: 'unlimited',
        },
      })
      const offer = await prisma.offer.create({
        data: {
          productId: product.id,
          name: '月付',
          isDefault: true,
          price: 100,
          stock: 0,
          deliveryMode: 'manual_service',
          stockMode: 'unlimited',
          externalIntegration: 'faka_bridge',
          externalSku: 'aster-basic',
        },
      })
      const { password } = await createTestUser('faka-capacity-public-read@test.local', 'pass123')
      const { accessToken } = await loginAs('faka-capacity-public-read@test.local', password)

      const list = await finishesWithin(api.get('/api/products'))
      const listed = list.body.items.find((item: { id: number }) => item.id === product.id)
      expect(list.status).toBe(200)
      expect(listed?.fakaCapacity?.source).toBe('unavailable')

      const detail = await finishesWithin(api.get(`/api/products/${product.id}`))
      expect(detail.status).toBe(200)
      expect(detail.body.fakaCapacity?.source).toBe('unavailable')

      const preview = await finishesWithin(
        api
          .get('/api/checkout/preview')
          .query({ productId: product.id, offerId: offer.id })
          .set(authHeader(accessToken))
      )
      expect(preview.status).toBe(200)
      expect(preview.body.fakaCapacity?.source).toBe('unavailable')
      expect(probe).toHaveBeenCalledTimes(1)

      pending.resolve(snapshot('aster-basic', 4))
      await expect(fetchFakaCapacityForSku('aster-basic')).resolves.toMatchObject({ remaining: 4 })
    } finally {
      pending.resolve(snapshot('aster-basic', 4))
      Object.assign(config.fakaBridge, originalConfig)
    }
  })
})
