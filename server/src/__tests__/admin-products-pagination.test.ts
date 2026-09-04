import { describe, it, expect, vi } from 'vitest'
import { config } from '../config/index.js'
import {
  __clearFakaCapacityCacheForTests,
  __setFakaCapacityProbeForTests,
  type FakaCapacitySnapshot,
} from '../lib/fakaBridge/capacity.js'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

async function loginAdmin(email = 'prod-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

async function loginUser(email = 'prod-user@test.local') {
  const { user, password } = await createTestUser(email, 'user123', 'user')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

describe('Admin Products Pagination Contract (PR 04)', () => {
  describe('Authentication & Authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await api.get('/api/admin/products').expect(401)
    })

    it('rejects regular user requests with 403', async () => {
      const user = await loginUser('prod-regular@test.local')
      await api
        .get('/api/admin/products')
        .set(authHeader(user.accessToken))
        .expect(403)
    })

    it('rejects merchant requests with 403', async () => {
      const { user, password } = await createTestMerchant('prod-merch@test.local', 'merch123')
      const { accessToken } = await loginAs(user.email, password)
      await api
        .get('/api/admin/products')
        .set(authHeader(accessToken))
        .expect(403)
    })

    it('allows admin requests with 200 and standard envelope', async () => {
      const admin = await loginAdmin('prod-auth-admin@test.local')
      const res = await api
        .get('/api/admin/products')
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body).toHaveProperty('items')
      expect(res.body).toHaveProperty('total')
      expect(res.body).toHaveProperty('page', 1)
      expect(res.body).toHaveProperty('pageSize', 20)
      expect(Array.isArray(res.body.items)).toBe(true)
      expect(typeof res.body.total).toBe('number')
    })
  })

  describe('Query Validation (.strict())', () => {
    it('rejects invalid page parameters with 400', async () => {
      const admin = await loginAdmin('prod-val-page@test.local')
      await api
        .get('/api/admin/products')
        .query({ page: 0 })
        .set(authHeader(admin.accessToken))
        .expect(400)

      await api
        .get('/api/admin/products')
        .query({ page: -1 })
        .set(authHeader(admin.accessToken))
        .expect(400)

      await api
        .get('/api/admin/products')
        .query({ page: 'abc' })
        .set(authHeader(admin.accessToken))
        .expect(400)
    })

    it('rejects invalid pageSize parameters with 400', async () => {
      const admin = await loginAdmin('prod-val-size@test.local')
      await api
        .get('/api/admin/products')
        .query({ pageSize: 0 })
        .set(authHeader(admin.accessToken))
        .expect(400)

      await api
        .get('/api/admin/products')
        .query({ pageSize: 101 })
        .set(authHeader(admin.accessToken))
        .expect(400)

      await api
        .get('/api/admin/products')
        .query({ pageSize: 'invalid' })
        .set(authHeader(admin.accessToken))
        .expect(400)
    })

    it('rejects invalid status parameter with 400', async () => {
      const admin = await loginAdmin('prod-val-status@test.local')
      await api
        .get('/api/admin/products')
        .query({ status: 'unknown_status' })
        .set(authHeader(admin.accessToken))
        .expect(400)
    })

    it('rejects invalid archived parameter with 400', async () => {
      const admin = await loginAdmin('prod-val-archived@test.local')
      await api
        .get('/api/admin/products')
        .query({ archived: 'not_allowed' })
        .set(authHeader(admin.accessToken))
        .expect(400)
    })

    it('rejects unknown query parameters with 400 due to .strict()', async () => {
      const admin = await loginAdmin('prod-val-strict@test.local')
      await api
        .get('/api/admin/products')
        .query({ unknownKey: 'malicious' })
        .set(authHeader(admin.accessToken))
        .expect(400)
    })

    it('rejects search query longer than 100 characters with 400', async () => {
      const admin = await loginAdmin('prod-val-q@test.local')
      await api
        .get('/api/admin/products')
        .query({ q: 'a'.repeat(101) })
        .set(authHeader(admin.accessToken))
        .expect(400)
    })
  })

  describe('Pagination, Disjoint Pages & Deterministic Sorting', () => {
    it('paginates 25 products with disjoint pages and sorted by createdAt DESC, id DESC', async () => {
      const admin = await loginAdmin('prod-paginate-admin@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const prefix = `PAGETEST-${Date.now()}`

      // Create 25 products with staggered createdAt
      const baseTime = new Date('2026-09-01T10:00:00.000Z').getTime()
      const createdIds: number[] = []

      for (let i = 1; i <= 25; i++) {
        const itemCreatedAt = new Date(baseTime + i * 1000)
        const p = await prisma.product.create({
          data: {
            name: `${prefix}-Product-${i.toString().padStart(2, '0')}`,
            type: '网络节点',
            categoryId,
            price: 100 + i,
            status: 'active',
            stock: 10,
            createdAt: itemCreatedAt,
          },
        })
        createdIds.push(p.id)
      }

      // Query page 1 (pageSize 10)
      const resPage1 = await api
        .get('/api/admin/products')
        .query({ q: prefix, page: 1, pageSize: 10 })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(resPage1.body.total).toBe(25)
      expect(resPage1.body.page).toBe(1)
      expect(resPage1.body.pageSize).toBe(10)
      expect(resPage1.body.items).toHaveLength(10)

      // Query page 2 (pageSize 10)
      const resPage2 = await api
        .get('/api/admin/products')
        .query({ q: prefix, page: 2, pageSize: 10 })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(resPage2.body.total).toBe(25)
      expect(resPage2.body.page).toBe(2)
      expect(resPage2.body.pageSize).toBe(10)
      expect(resPage2.body.items).toHaveLength(10)

      // Query page 3 (pageSize 10)
      const resPage3 = await api
        .get('/api/admin/products')
        .query({ q: prefix, page: 3, pageSize: 10 })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(resPage3.body.total).toBe(25)
      expect(resPage3.body.page).toBe(3)
      expect(resPage3.body.items).toHaveLength(5)

      // Check disjointness
      const idsPage1 = new Set(resPage1.body.items.map((it: any) => it.id))
      const idsPage2 = new Set(resPage2.body.items.map((it: any) => it.id))
      const idsPage3 = new Set(resPage3.body.items.map((it: any) => it.id))

      for (const id of idsPage2) {
        expect(idsPage1.has(id)).toBe(false)
      }
      for (const id of idsPage3) {
        expect(idsPage1.has(id)).toBe(false)
        expect(idsPage2.has(id)).toBe(false)
      }

      // Check completeness: all 25 items retrieved
      const allRetrieved = [...resPage1.body.items, ...resPage2.body.items, ...resPage3.body.items]
      expect(allRetrieved).toHaveLength(25)
      const allRetrievedIds = allRetrieved.map((it: any) => it.id)
      for (const id of createdIds) {
        expect(allRetrievedIds).toContain(id)
      }

      // Verify descending order
      for (let i = 0; i < allRetrieved.length - 1; i++) {
        const curr = allRetrieved[i]
        const next = allRetrieved[i + 1]
        const currTime = new Date(curr.createdAt).getTime()
        const nextTime = new Date(next.createdAt).getTime()
        expect(currTime).toBeGreaterThanOrEqual(nextTime)
        if (currTime === nextTime) {
          expect(curr.id).toBeGreaterThan(next.id)
        }
      }
    })

    it('strictly tie-breaks items with identical createdAt by id DESC', async () => {
      const admin = await loginAdmin('prod-tiebreak-admin@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const prefix = `TIE-${Date.now()}`
      const identicalTime = new Date('2026-09-02T12:00:00.000Z')

      const p1 = await prisma.product.create({
        data: {
          name: `${prefix}-ItemA`,
          type: '网络节点',
          categoryId,
          price: 50,
          status: 'active',
          stock: 1,
          createdAt: identicalTime,
        },
      })
      const p2 = await prisma.product.create({
        data: {
          name: `${prefix}-ItemB`,
          type: '网络节点',
          categoryId,
          price: 50,
          status: 'active',
          stock: 1,
          createdAt: identicalTime,
        },
      })

      const res = await api
        .get('/api/admin/products')
        .query({ q: prefix, page: 1, pageSize: 10 })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.items).toHaveLength(2)
      // Since p2 was created after p1, p2.id > p1.id, so p2 must appear before p1
      expect(res.body.items[0].id).toBe(Math.max(p1.id, p2.id))
      expect(res.body.items[1].id).toBe(Math.min(p1.id, p2.id))
    })
  })

  describe('Filtering: q, status, archived', () => {
    it('supports case-insensitive name matching in q', async () => {
      const admin = await loginAdmin('prod-filter-q-text@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const uniqueCode = `UniQue_${Date.now()}`

      await prisma.product.create({
        data: {
          name: `Special Product ${uniqueCode}`,
          type: '网络节点',
          categoryId,
          price: 120,
          status: 'active',
          stock: 5,
        },
      })

      // Query with lowercase
      const res = await api
        .get('/api/admin/products')
        .query({ q: uniqueCode.toLowerCase() })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].name).toContain(uniqueCode)
    })

    it('supports numeric ID search in q', async () => {
      const admin = await loginAdmin('prod-filter-q-num@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()

      const p = await prisma.product.create({
        data: {
          name: `Specific Product For Id Search ${Date.now()}`,
          type: '网络节点',
          categoryId,
          price: 99,
          status: 'active',
          stock: 2,
        },
      })

      const res = await api
        .get('/api/admin/products')
        .query({ q: String(p.id) })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.items.some((item: any) => item.id === p.id)).toBe(true)
    })

    it('filters by status: draft, active, inactive', async () => {
      const admin = await loginAdmin('prod-filter-status@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `STAT-${Date.now()}`

      await prisma.product.create({
        data: { name: `${tag}-draft`, type: '网络节点', categoryId, price: 10, status: 'draft', stock: 1 },
      })
      await prisma.product.create({
        data: { name: `${tag}-active`, type: '网络节点', categoryId, price: 10, status: 'active', stock: 1 },
      })
      await prisma.product.create({
        data: { name: `${tag}-inactive`, type: '网络节点', categoryId, price: 10, status: 'inactive', stock: 1 },
      })

      const resDraft = await api
        .get('/api/admin/products')
        .query({ q: tag, status: 'draft' })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resDraft.body.total).toBe(1)
      expect(resDraft.body.items[0].status).toBe('draft')

      const resActive = await api
        .get('/api/admin/products')
        .query({ q: tag, status: 'active' })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resActive.body.total).toBe(1)
      expect(resActive.body.items[0].status).toBe('active')

      const resInactive = await api
        .get('/api/admin/products')
        .query({ q: tag, status: 'inactive' })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resInactive.body.total).toBe(1)
      expect(resInactive.body.items[0].status).toBe('inactive')
    })

    it('filters by archived: exclude (default), only, all', async () => {
      const admin = await loginAdmin('prod-filter-archived@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `ARCH-${Date.now()}`

      await prisma.product.create({
        data: {
          name: `${tag}-normal`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'active',
          stock: 1,
          archivedAt: null,
        },
      })
      await prisma.product.create({
        data: {
          name: `${tag}-archived`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'inactive',
          stock: 1,
          archivedAt: new Date(),
        },
      })

      // Default / exclude: only normal product
      const resExclude = await api
        .get('/api/admin/products')
        .query({ q: tag, archived: 'exclude' })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resExclude.body.total).toBe(1)
      expect(resExclude.body.items[0].name).toBe(`${tag}-normal`)

      // Default without archived query param should also exclude
      const resDefault = await api
        .get('/api/admin/products')
        .query({ q: tag })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resDefault.body.total).toBe(1)
      expect(resDefault.body.items[0].name).toBe(`${tag}-normal`)

      // Only: only archived product
      const resOnly = await api
        .get('/api/admin/products')
        .query({ q: tag, archived: 'only' })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resOnly.body.total).toBe(1)
      expect(resOnly.body.items[0].name).toBe(`${tag}-archived`)

      // All: both products
      const resAll = await api
        .get('/api/admin/products')
        .query({ q: tag, archived: 'all' })
        .set(authHeader(admin.accessToken))
        .expect(200)
      expect(resAll.body.total).toBe(2)
    })

    it('combines q, status, and archived filters with AND semantics', async () => {
      const admin = await loginAdmin('prod-filter-combined@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `COMB-${Date.now()}`

      await prisma.product.create({
        data: {
          name: `${tag}-match`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'active',
          stock: 1,
          archivedAt: null,
        },
      })
      await prisma.product.create({
        data: {
          name: `${tag}-wrong-status`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'draft',
          stock: 1,
          archivedAt: null,
        },
      })
      await prisma.product.create({
        data: {
          name: `${tag}-archived-match`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'active',
          stock: 1,
          archivedAt: new Date(),
        },
      })

      const res = await api
        .get('/api/admin/products')
        .query({ q: tag, status: 'active', archived: 'exclude' })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items[0].name).toBe(`${tag}-match`)
    })
  })

  describe('Field Stripping & Per-page Projection Boundary', () => {
    it('strips fixedContent and legacy isHot from all returned items', async () => {
      const admin = await loginAdmin('prod-strip-admin@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `STRIP-${Date.now()}`

      await prisma.product.create({
        data: {
          name: `${tag}-product`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'active',
          stock: 1,
          fixedContent: 'SENSITIVE_FIXED_CONTENT_NEVER_LEAK',
        },
      })

      const res = await api
        .get('/api/admin/products')
        .query({ q: tag })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.items).toHaveLength(1)
      const item = res.body.items[0]
      expect(item.fixedContent).toBeUndefined()
      expect(item.isHot).toBeUndefined()
    })

    it('returns empty items array with total intact on out-of-bounds page', async () => {
      const admin = await loginAdmin('prod-oob-admin@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `OOB-${Date.now()}`

      await prisma.product.create({
        data: { name: `${tag}-1`, type: '网络节点', categoryId, price: 10, status: 'active', stock: 1 },
      })

      const res = await api
        .get('/api/admin/products')
        .query({ q: tag, page: 999, pageSize: 20 })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.page).toBe(999)
      expect(res.body.pageSize).toBe(20)
      expect(res.body.items).toEqual([])
    })

    it('restricts offers and inventory counts to current page items only', async () => {
      const admin = await loginAdmin('prod-scoped-admin@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `SCOPE-${Date.now()}`

      const p1 = await prisma.product.create({
        data: {
          name: `${tag}-1`,
          type: '网络节点',
          categoryId,
          price: 10,
          status: 'active',
          stock: 5,
          createdAt: new Date('2026-09-03T10:00:00.000Z'),
        },
      })
      const offer1 = await prisma.offer.create({
        data: { productId: p1.id, name: 'Offer 1', price: 10, stock: 5, isDefault: true },
      })
      await prisma.inventoryItem.create({
        data: { productId: p1.id, offerId: offer1.id, content: 'item-1', status: 'available' },
      })

      const p2 = await prisma.product.create({
        data: {
          name: `${tag}-2`,
          type: '网络节点',
          categoryId,
          price: 20,
          status: 'active',
          stock: 1,
          createdAt: new Date('2026-09-03T09:00:00.000Z'),
        },
      })
      const offer2 = await prisma.offer.create({
        data: { productId: p2.id, name: 'Offer 2', price: 20, stock: 1, isDefault: true },
      })

      // Query page 1 with pageSize 1 -> should only contain p1 and its offer/inventory
      const res = await api
        .get('/api/admin/products')
        .query({ q: tag, page: 1, pageSize: 1 })
        .set(authHeader(admin.accessToken))
        .expect(200)

      expect(res.body.total).toBe(2)
      expect(res.body.items).toHaveLength(1)
      expect(res.body.items[0].id).toBe(p1.id)
      expect(res.body.items[0].offers).toHaveLength(1)
      expect(res.body.items[0].offers[0].name).toBe('Offer 1')
      expect(res.body.items[0]._count?.inventory).toBe(1)
    })

    it('empirically scopes Faka SKU capacity reads strictly to current page and never probes out-of-page SKUs', async () => {
      const admin = await loginAdmin('prod-faka-scoped-admin@test.local')
      const categoryId = await getActiveNetworkNodeCategoryId()
      const tag = `FAKA-SCOPE-${Date.now()}`

      const originalConfig = { ...config.fakaBridge }
      Object.assign(config.fakaBridge, {
        enabled: true,
        url: 'https://faka.test.local/order-paid',
        statusUrl: 'https://faka.test.local/order-status',
        secret: 'test-faka-secret-at-least-32-chars-long!!',
        timeoutMs: 5_000,
        maxAttempts: 3,
        allowInsecureTargets: false,
      })

      const probe = vi.fn(async (sku: string): Promise<FakaCapacitySnapshot> => ({
        sku,
        planId: 100,
        capacityLimit: 50,
        activeUsers: 10,
        remaining: 40,
        sellable: true,
        source: 'xboard',
      }))
      __clearFakaCapacityCacheForTests()
      __setFakaCapacityProbeForTests(probe)

      try {
        const skuPage1 = `sku-page-1-${Date.now()}`
        const skuPage2 = `sku-page-2-${Date.now()}`

        // Product 1 (newer, will be on page 1)
        const p1 = await prisma.product.create({
          data: {
            name: `${tag}-Product-Page1`,
            type: '网络节点',
            categoryId,
            price: 50,
            status: 'active',
            stock: 10,
            createdAt: new Date('2026-09-04T12:00:00.000Z'),
          },
        })
        await prisma.offer.create({
          data: {
            productId: p1.id,
            name: 'Faka Offer P1',
            price: 50,
            stock: 10,
            isDefault: true,
            externalIntegration: 'faka_bridge',
            externalSku: skuPage1,
          },
        })

        // Product 2 (older, will be on page 2)
        const p2 = await prisma.product.create({
          data: {
            name: `${tag}-Product-Page2`,
            type: '网络节点',
            categoryId,
            price: 60,
            status: 'active',
            stock: 10,
            createdAt: new Date('2026-09-04T10:00:00.000Z'),
          },
        })
        await prisma.offer.create({
          data: {
            productId: p2.id,
            name: 'Faka Offer P2',
            price: 60,
            stock: 10,
            isDefault: true,
            externalIntegration: 'faka_bridge',
            externalSku: skuPage2,
          },
        })

        // 1. Query page 1 (pageSize: 1)
        const resPage1 = await api
          .get('/api/admin/products')
          .query({ q: tag, page: 1, pageSize: 1 })
          .set(authHeader(admin.accessToken))
          .expect(200)

        expect(resPage1.body.total).toBe(2)
        expect(resPage1.body.items).toHaveLength(1)
        expect(resPage1.body.items[0].id).toBe(p1.id)
        expect(resPage1.body.items[0].fakaBridge).toBe(true)
        expect(resPage1.body.items[0].offers[0].externalSku).toBe(skuPage1)

        // Empirical check: probe must have been called for skuPage1, NEVER for skuPage2
        expect(probe).toHaveBeenCalledWith(skuPage1)
        expect(probe).not.toHaveBeenCalledWith(skuPage2)

        // 2. Query page 2 (pageSize: 1)
        probe.mockClear()
        const resPage2 = await api
          .get('/api/admin/products')
          .query({ q: tag, page: 2, pageSize: 1 })
          .set(authHeader(admin.accessToken))
          .expect(200)

        expect(resPage2.body.total).toBe(2)
        expect(resPage2.body.items).toHaveLength(1)
        expect(resPage2.body.items[0].id).toBe(p2.id)
        expect(resPage2.body.items[0].fakaBridge).toBe(true)
        expect(resPage2.body.items[0].offers[0].externalSku).toBe(skuPage2)

        // Empirical check: probe must have been called for skuPage2, NEVER for skuPage1
        expect(probe).toHaveBeenCalledWith(skuPage2)
        expect(probe).not.toHaveBeenCalledWith(skuPage1)
      } finally {
        Object.assign(config.fakaBridge, originalConfig)
        __clearFakaCapacityCacheForTests()
      }
    })
  })
})
