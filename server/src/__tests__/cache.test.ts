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
