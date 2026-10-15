import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { __resetCacheForTests } from '../../lib/cache.js'
import { __resetRedisForTests, __setRedisForTests, type RedisLike } from '../../lib/redis.js'
import {
  __clearFakaCapacityCacheForTests,
  __setFakaCapacityProbeForTests,
  type FakaCapacitySnapshot,
} from '../../lib/fakaBridge/capacity.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'

class FakeRedis implements RedisLike {
  readonly store = new Map<string, string>()
  async get(key: string) { return this.store.get(key) ?? null }
  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes('NX') && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }
  async del(...keys: string[]) { return keys.filter(key => this.store.delete(key)).length }
  async incr(key: string) {
    const next = Number(this.store.get(key) ?? '0') + 1
    this.store.set(key, String(next))
    return next
  }
  async eval(): Promise<unknown> { throw new Error('not used by product list cache') }
  async ping() { return 'PONG' }
}

const mutableConfig = config as typeof config & { redisEnabled: boolean; cacheProductList: boolean }

async function product(name: string, merchantId: number | null, data: {
  visibility?: 'public' | 'members_only'
  description?: string
  externalSku?: string
} = {}) {
  const created = await prisma.product.create({
    data: {
      name, description: data.description, type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId(),
      price: 100, stock: 0, status: 'active', visibility: data.visibility ?? 'public', merchantId,
      deliveryMode: 'manual_service', stockMode: 'unlimited',
    },
  })
  await prisma.offer.create({
    data: {
      productId: created.id, name: '默认', isDefault: true, price: 100, stock: 0,
      deliveryMode: 'manual_service', stockMode: 'unlimited',
      ...(data.externalSku ? { externalIntegration: 'faka_bridge', externalSku: data.externalSku } : {}),
    },
  })
  return created
}

type Body = { shop: { id: number; name: string; description: string | null }; items: Array<{ id: number; name: string; availability: { status: string } }>; nextCursor: string | null; hasMore: boolean }
const ids = (body: Body) => body.items.map(item => item.id)
const shop = (merchantId: number, query: Record<string, string> = {}, token?: string) => {
  const request = api.get(`/api/shops/${merchantId}/products`).query(query)
  return token ? request.set(authHeader(token)) : request
}

describe('public merchant shops', () => {
  it('scopes products to one active merchant, honours audience and exposes only the public profile', async () => {
    const { merchant: a } = await createTestMerchant('shop-a@test.local', 'pass123', { name: '店铺A' })
    const { merchant: b } = await createTestMerchant('shop-b@test.local', 'pass123', { name: '店铺B' })
    await prisma.merchant.update({ where: { id: a.id }, data: { description: '  第一行\n第二行  ' } })
    const a1 = await product('A公开', a.id)
    const a2 = await product('A会员', a.id, { visibility: 'members_only' })
    await product('B公开', b.id)
    await product('平台公开', null)

    const guest = await shop(a.id).expect(200)
    expect(guest.headers['cache-control']).toBe('private, no-store')
    expect(Object.keys(guest.body).sort()).toEqual(['hasMore', 'items', 'nextCursor', 'shop'])
    expect(guest.body.shop).toEqual({ id: a.id, name: '店铺A', description: '第一行\n第二行' })
    expect(ids(guest.body)).toEqual([a1.id])
    expect(guest.body).toMatchObject({ nextCursor: null, hasMore: false })

    await createTestUser('shop-buyer@test.local', 'pass123')
    const buyer = await loginAs('shop-buyer@test.local', 'pass123')
    expect(ids((await shop(a.id, {}, buyer.accessToken).expect(200)).body)).toEqual([a2.id, a1.id])
    // An invalid bearer token keeps the auth error instead of degrading to a guest read.
    await shop(a.id, {}, 'not-a-jwt').expect(401)

    // Search stays inside the shop; a single character is a valid query.
    expect(ids((await shop(a.id, { q: '公开' }).expect(200)).body)).toEqual([a1.id])
    expect(ids((await shop(a.id, { q: '  ' }).expect(200)).body)).toEqual([a1.id])
    expect(ids((await shop(b.id, { q: 'A' }).expect(200)).body)).toEqual([])
    await shop(a.id, { q: 'x'.repeat(51) }).expect(400)

    // Empty active shop: 200 with the profile; whitespace-only description is null; long text is bounded.
    const { merchant: empty } = await createTestMerchant('shop-empty@test.local', 'pass123', { name: '空店' })
    await prisma.merchant.update({ where: { id: empty.id }, data: { description: '   ' } })
    expect((await shop(empty.id).expect(200)).body).toEqual({
      shop: { id: empty.id, name: '空店', description: null }, items: [], nextCursor: null, hasMore: false,
    })
    await prisma.merchant.update({ where: { id: empty.id }, data: { description: '😀'.repeat(501) } })
    expect((await shop(empty.id).expect(200)).body.shop.description).toBe(`${'😀'.repeat(500)}…`)

    for (const status of ['pending', 'suspended', 'rejected'] as const) {
      const { merchant } = await createTestMerchant(`shop-${status}@test.local`, 'pass123', { status })
      await product(`${status}商品`, merchant.id)
      const res = await shop(merchant.id).expect(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: '店铺暂不可用' })
    }
    await shop(999_999).expect(404)
    await shop(0).expect(400)
    await api.get('/api/shops/abc/products').expect(400)
    await api.get('/api/shops/99999999999/products').expect(400)
  })

  it('pages 24 at a time in organic rank order with cursors bound to shop, search and audience', async () => {
    const { merchant: a } = await createTestMerchant('rank-a@test.local', 'pass123')
    const { merchant: b } = await createTestMerchant('rank-b@test.local', 'pass123')
    const created = []
    for (let i = 0; i < 27; i++) created.push(await product(`商品${i}`, a.id))
    await product('B商品', b.id)
    const categoryId = await getActiveNetworkNodeCategoryId()
    const hot = created[3]
    const busy = created[10]
    const completedAt = new Date()
    await prisma.merchandisingRun.create({
      data: {
        status: 'completed', windowStart: new Date(completedAt.getTime() - 30 * 86_400_000), windowEnd: completedAt,
        windowDays: 30, minSales: 5, topPercent: 20, startedAt: new Date(completedAt.getTime() - 1_000), completedAt,
        snapshots: { create: [
          { productId: hot.id, categoryId, effectiveOrderCount: 9, categoryRank: 1, isHot: true, categoryPopulation: 2, computedAt: completedAt },
          { productId: busy.id, categoryId, effectiveOrderCount: 30, categoryRank: 2, isHot: false, categoryPopulation: 2, computedAt: completedAt },
        ] },
      },
    })
    const expected = [hot.id, busy.id, ...created.filter(p => p !== hot && p !== busy).map(p => p.id).reverse()]

    const first = (await shop(a.id).expect(200)).body as Body
    expect(ids(first)).toEqual(expected.slice(0, 24))
    expect(first.hasMore).toBe(true)
    const second = (await shop(a.id, { cursor: first.nextCursor! }).expect(200)).body as Body
    expect(ids(second)).toEqual(expected.slice(24))
    expect(second).toMatchObject({ hasMore: false, nextCursor: null })

    const cursor = first.nextCursor!
    await createTestUser('rank-buyer@test.local', 'pass123')
    const buyer = await loginAs('rank-buyer@test.local', 'pass123')
    for (const misuse of [
      shop(b.id, { cursor }),
      shop(a.id, { cursor, q: '商品' }),
      shop(a.id, { cursor }, buyer.accessToken),
      api.get('/api/products').query({ cursor }),
    ]) {
      expect((await misuse.expect(409)).body.error.code).toBe('PRODUCT_CURSOR_EXPIRED')
    }
    expect((await shop(a.id, { cursor: 'garbage' }).expect(400)).body.error.code).toBe('PRODUCT_CURSOR_INVALID')
    // A site-wide cursor cannot open a shop page either.
    const siteCursor = (await api.get('/api/products').query({ pageSize: 1 }).expect(200)).body.nextCursor
    expect((await shop(a.id, { cursor: siteCursor }).expect(409)).body.error.code).toBe('PRODUCT_CURSOR_EXPIRED')
  })

  describe('with the product-list cache enabled', () => {
    const originalFaka = { ...config.fakaBridge }

    beforeEach(async () => {
      mutableConfig.redisEnabled = true
      mutableConfig.cacheProductList = true
      __setRedisForTests(new FakeRedis())
      await __resetCacheForTests()
    })

    afterEach(() => {
      __setFakaCapacityProbeForTests(undefined)
      __clearFakaCapacityCacheForTests()
      Object.assign(config.fakaBridge, originalFaka)
      __resetRedisForTests()
      mutableConfig.redisEnabled = false
    })

    it('isolates shops in cache and re-checks merchant, visibility and ownership on a hot page', async () => {
      const { merchant: a } = await createTestMerchant('cache-a@test.local', 'pass123', { name: '缓存A' })
      const { merchant: b } = await createTestMerchant('cache-b@test.local', 'pass123', { name: '缓存B' })
      const a1 = await product('A一', a.id)
      const a2 = await product('A二', a.id)
      const a3 = await product('A三', a.id)
      const b1 = await product('B一', b.id)

      expect(ids((await shop(a.id).expect(200)).body)).toEqual([a3.id, a2.id, a1.id])
      expect(ids((await shop(b.id).expect(200)).body)).toEqual([b1.id])
      // Raw writes skip cache invalidation, so the stale name proves the next read is a cache hit.
      await prisma.product.update({ where: { id: a1.id }, data: { name: 'A一改名' } })
      await prisma.product.update({ where: { id: a2.id }, data: { visibility: 'members_only' } })
      await prisma.product.update({ where: { id: a3.id }, data: { merchantId: b.id } })
      await prisma.merchant.update({ where: { id: a.id }, data: { name: '缓存A新名' } })
      const hit = (await shop(a.id).expect(200)).body as Body
      expect(hit.items.map(item => item.name)).toEqual(['A一'])
      expect(hit.shop.name).toBe('缓存A新名')

      await prisma.merchant.update({ where: { id: a.id }, data: { status: 'suspended' } })
      await shop(a.id).expect(404)
    })

    it('keeps available, unavailable and unknown products browsable and does not cache unknown capacity', async () => {
      Object.assign(config.fakaBridge, {
        enabled: true,
        url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
        statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
        secret: 'unit-test-faka-secret-at-least-32-characters!!',
        timeoutMs: 5_000, maxAttempts: 3, allowInsecureTargets: false,
      })
      // The background probe never settles, so the Faka offer stays unknown during the test.
      __setFakaCapacityProbeForTests(() => new Promise<FakaCapacitySnapshot>(() => {}))
      const { merchant } = await createTestMerchant('state-a@test.local', 'pass123')
      const available = await product('可售', merchant.id)
      const soldOut = await createTestProduct('售罄', 100, 0, [], merchant.id)
      const unknown = await product('待确认', merchant.id, { externalSku: 'shop-unknown-sku' })

      const read = async () => {
        const body = (await shop(merchant.id).expect(200)).body as Body
        return new Map(body.items.map(item => [item.id, item]))
      }
      const first = await read()
      expect(first.get(available.id)!.availability).toEqual({ status: 'available' })
      expect(first.get(soldOut.id)!.availability).toEqual({ status: 'unavailable' })
      expect(first.get(unknown.id)!.availability).toEqual({ status: 'unknown' })

      await prisma.product.update({ where: { id: available.id }, data: { name: '可售改名' } })
      expect((await read()).get(available.id)!.name).toBe('可售改名')
    })
  })
})
