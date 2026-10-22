import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCacheForTests,
  bumpCacheVersion,
  bumpProductListVersionCoalesced,
  getCacheVersion,
  wrapCache,
} from '../lib/cache.js'
import { badRequest, notFound } from '../lib/httpError.js'
import { __resetRedisForTests, __setRedisForTests } from '../lib/redis.js'
import { config } from '../config/index.js'
import {
  __clearFakaCapacityCacheForTests,
  __setFakaCapacityProbeForTests,
  prewarmFakaCapacityForSkus,
  type FakaCapacitySnapshot,
} from '../lib/fakaBridge/capacity.js'
import { prisma } from '../lib/prisma.js'
import { api } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

class FakeRedis {
  readonly store = new Map<string, string>()

  async get(key: string) {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes('NX') && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]) {
    let count = 0
    for (const key of keys) {
      if (this.store.delete(key)) count += 1
    }
    return count
  }

  async incr(key: string) {
    const next = Number(this.store.get(key) ?? '0') + 1
    this.store.set(key, String(next))
    return next
  }

  // Cache tests never invoke Lua, but the shared RedisLike contract requires
  // the atomic primitive so an incomplete fake cannot accidentally model the
  // security limiter as available.
  async eval() {
    throw new Error('FakeRedis.eval is not implemented for cache tests')
  }

  async ping() {
    return 'PONG'
  }

  async keys(pattern: string) {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
    return [...this.store.keys()].filter(key => key.startsWith(prefix))
  }
}

const mutableConfig = config as typeof config & {
  redisEnabled: boolean
  cacheProductList: boolean
  cacheProductDetail: boolean
  cacheProductReviews: boolean
  redisCommandTimeoutMs: number
  cacheProductListVersionCoalesceMs: number
}

describe('cache wrapper', () => {
  let redis: FakeRedis

  beforeEach(async () => {
    mutableConfig.redisEnabled = true
    mutableConfig.cacheProductList = true
    mutableConfig.cacheProductDetail = true
    mutableConfig.cacheProductReviews = true
    mutableConfig.redisCommandTimeoutMs = 50
    mutableConfig.cacheProductListVersionCoalesceMs = 10_000
    redis = new FakeRedis()
    __setRedisForTests(redis)
    await __resetCacheForTests()
  })

  afterEach(() => {
    __resetRedisForTests()
    mutableConfig.redisEnabled = false
  })

  it('serves a second request from Redis after a miss fill', async () => {
    const fallback = vi.fn().mockResolvedValue({ id: 1, ratingAvg: 4.5 })

    await expect(wrapCache('product-detail', 'product:1', 60, fallback)).resolves.toEqual({
      id: 1,
      ratingAvg: 4.5,
    })
    await expect(wrapCache('product-detail', 'product:1', 60, fallback)).resolves.toEqual({
      id: 1,
      ratingAvg: 4.5,
    })

    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('does not freeze a transient fallback when cachePredicate rejects it', async () => {
    const fallback = vi
      .fn<() => Promise<{ source: string }>>()
      .mockResolvedValueOnce({ source: 'unavailable' })
      .mockResolvedValueOnce({ source: 'xboard' })

    await expect(
      wrapCache('product-detail', 'product:faka-capacity', 60, fallback, {
        cachePredicate: value => value.source !== 'unavailable',
      })
    ).resolves.toEqual({ source: 'unavailable' })
    await expect(
      wrapCache('product-detail', 'product:faka-capacity', 60, fallback, {
        cachePredicate: value => value.source !== 'unavailable',
      })
    ).resolves.toEqual({ source: 'xboard' })
    await expect(
      wrapCache('product-detail', 'product:faka-capacity', 60, fallback, {
        cachePredicate: value => value.source !== 'unavailable',
      })
    ).resolves.toEqual({ source: 'xboard' })

    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('negative-caches 404 errors and rethrows equivalent HttpError', async () => {
    const fallback = vi.fn().mockRejectedValue(notFound('商品不存在'))

    await expect(
      wrapCache('product-detail', 'product:missing', 60, fallback, {
        negativeTtlSec: 10,
        negativeErrorPredicate: err => err instanceof Error && 'status' in err && err.status === 404,
      })
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: '商品不存在' })

    await expect(
      wrapCache('product-detail', 'product:missing', 60, fallback, {
        negativeTtlSec: 10,
        negativeErrorPredicate: err => err instanceof Error && 'status' in err && err.status === 404,
      })
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: '商品不存在' })

    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('does not negative-cache 400 errors', async () => {
    const fallback = vi.fn().mockRejectedValue(badRequest('商品已下架'))

    for (let i = 0; i < 2; i += 1) {
      await expect(
        wrapCache('product-detail', 'product:inactive', 60, fallback, {
          negativeTtlSec: 10,
          negativeErrorPredicate: err => err instanceof Error && 'status' in err && err.status === 404,
        })
      ).rejects.toMatchObject({ status: 400, message: '商品已下架' })
    }

    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent same-key misses inside one process', async () => {
    const fallback = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return { items: [1, 2, 3] }
    })

    const results = await Promise.all(
      Array.from({ length: 100 }, () => wrapCache('product-list', 'products:hot', 30, fallback))
    )

    expect(results).toHaveLength(100)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('reads and bumps cache versions', async () => {
    await expect(getCacheVersion({ name: 'product-detail', productId: 1 })).resolves.toBe(0)

    await bumpCacheVersion({ name: 'product-detail', productId: 1 })
    await bumpCacheVersion({ name: 'product-detail', productId: 1 })

    await expect(getCacheVersion({ name: 'product-detail', productId: 1 })).resolves.toBe(2)
  })

  it('coalesces product-list version bumps', async () => {
    await bumpProductListVersionCoalesced()
    await bumpProductListVersionCoalesced()

    await expect(getCacheVersion({ name: 'product-list' })).resolves.toBe(1)
  })
})

describe('product list/detail cache with public availability', () => {
  const originalFaka = { ...config.fakaBridge }

  beforeEach(async () => {
    mutableConfig.redisEnabled = true
    mutableConfig.cacheProductList = true
    mutableConfig.cacheProductDetail = true
    mutableConfig.redisCommandTimeoutMs = 50
    __setRedisForTests(new FakeRedis())
    await __resetCacheForTests()
    __clearFakaCapacityCacheForTests()
    Object.assign(config.fakaBridge, {
      enabled: true,
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      timeoutMs: 5_000,
      maxAttempts: 3,
      allowInsecureTargets: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    __setFakaCapacityProbeForTests(undefined)
    __clearFakaCapacityCacheForTests()
    Object.assign(config.fakaBridge, originalFaka)
    __resetRedisForTests()
    mutableConfig.redisEnabled = false
  })

  it('never caches a partly unknown projection, caches it once known, and degrades/recovers with snapshot age', async () => {
    const plan = (sku: string, planId: number, remaining: number): FakaCapacitySnapshot => ({
      sku, planId, capacityLimit: 10, activeUsers: 10 - remaining, remaining, sellable: remaining > 0, source: 'xboard',
    })
    // Probes are released explicitly: a pending refresh coalesces with later prewarms.
    const pending: Array<() => void> = []
    const heldProbe = (resolveWith: (sku: string) => FakaCapacitySnapshot) => async (sku: string) =>
      new Promise<FakaCapacitySnapshot>(resolve => pending.push(() => resolve(resolveWith(sku))))
    const releaseAll = () => pending.splice(0).forEach(release => release())
    __setFakaCapacityProbeForTests(async sku =>
      sku.startsWith('plan-5-') ? plan(sku, 5, 3) : heldProbe(s => plan(s, 6, 2))(sku))
    await prewarmFakaCapacityForSkus(['plan-5-month'])

    const product = await prisma.product.create({
      data: {
        name: '缓存v1', type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId(), price: 100, stock: 0,
        status: 'active', visibility: 'public', deliveryMode: 'manual_service', stockMode: 'unlimited',
      },
    })
    // SPEC-CATALOG-VIS-001 §4.2（P1.5）：游客读取详情还要求准入已批准。
    await prisma.productGuestEligibility.create({
      data: { productId: product.id, decision: 'approved', reviewedRevision: 1 },
    })
    const offer = (name: string, externalSku: string) => prisma.offer.create({
      data: {
        productId: product.id, name, price: 100, stock: 0, deliveryMode: 'manual_service', stockMode: 'unlimited',
        externalIntegration: 'faka_bridge', externalSku,
      },
    })
    const month = await offer('月付', 'plan-5-month')
    await offer('年付', 'plan-5-year')
    const named = await offer('独立套餐', 'named-b')

    const read = async () => {
      const list = await api.get('/api/products').expect(200)
      const detail = await api.get(`/api/products/${product.id}`).expect(200)
      return { listed: list.body.items.find((item: { id: number }) => item.id === product.id), detail: detail.body }
    }

    // Product is available via plan 5, but the named offer is still unknown → nothing cached.
    let { listed, detail } = await read()
    expect(listed.availability).toEqual({ status: 'available' })
    expect(listed.stock).toBe(3) // two period SKUs of one plan share capacity, not 6
    expect(detail.offers.find((o: { id: number }) => o.id === named.id).availability).toEqual({ status: 'unknown' })
    await prisma.product.update({ where: { id: product.id }, data: { name: '缓存v2' } })
    ;({ listed, detail } = await read())
    expect([listed.name, detail.name]).toEqual(['缓存v2', '缓存v2'])

    // Once every evaluated offer is known, the projection is cacheable.
    const warmed = prewarmFakaCapacityForSkus(['named-b'])
    releaseAll()
    await warmed
    ;({ listed, detail } = await read())
    expect(detail.offers.every((o: { availability: { status: string } }) => o.availability.status === 'available')).toBe(true)
    await prisma.product.update({ where: { id: product.id }, data: { name: '缓存v3' } })
    ;({ listed, detail } = await read())
    expect([listed.name, detail.name]).toEqual(['缓存v2', '缓存v2'])

    // Beyond the bounded stale window the snapshots are unknown again; after a refresh they recover.
    await __resetCacheForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 10 * 60_000)
    __setFakaCapacityProbeForTests(heldProbe(sku => plan(sku, sku.startsWith('plan-5-') ? 5 : 6, 1)))
    ;({ detail } = await read())
    expect(detail.availability).toEqual({ status: 'unknown' })
    expect(detail.offers.find((o: { id: number }) => o.id === month.id).availability).toEqual({ status: 'unknown' })

    const refreshed = prewarmFakaCapacityForSkus(['plan-5-month', 'named-b'])
    releaseAll()
    await refreshed
    ;({ detail } = await read())
    expect(detail.availability).toEqual({ status: 'available' })
  })
})
