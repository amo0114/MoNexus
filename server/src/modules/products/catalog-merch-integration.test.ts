import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api } from '../../__tests__/helpers.js'
import { getActiveCategoryIdByLabel } from '../../__tests__/catalogFixture.js'

async function createProduct(
  name: string,
  categoryId: number,
  type: string,
  data: { isHot?: boolean; sales?: number; merchantId?: number | null } = {},
) {
  return prisma.product.create({
    data: {
      name,
      categoryId,
      type,
      price: 100,
      status: 'active',
      isHot: data.isHot ?? false,
      sales: data.sales ?? 0,
      merchantId: data.merchantId,
    },
  })
}

async function createCompletedRun(
  completedAt: Date,
  snapshots: Array<{
    productId: number
    categoryId: number
    effectiveOrderCount: number
    categoryRank: number
    isHot: boolean
  }>,
) {
  return prisma.merchandisingRun.create({
    data: {
      status: 'completed',
      windowStart: new Date(completedAt.getTime() - 30 * 24 * 60 * 60 * 1000),
      windowEnd: completedAt,
      windowDays: 30,
      minSales: 5,
      topPercent: 20,
      startedAt: new Date(completedAt.getTime() - 1_000),
      completedAt,
      snapshots: {
        create: snapshots.map(snapshot => ({
          ...snapshot,
          categoryPopulation: snapshots.filter(item => item.categoryId === snapshot.categoryId).length,
          computedAt: completedAt,
        })),
      },
    },
  })
}

describe('Catalog/Merch public Product integration', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  it('mounts public, merchant and admin merchandising routers at their frozen API paths', async () => {
    await api.get('/api/products/sponsored').expect(200, { items: [] })
    await api.get('/api/products/editorial').expect(200, { items: [] })
    await api.get('/api/merchant/promotion-packages').expect(401)
    await api.get('/api/merchant/entitlements').expect(401)
    await api.get('/api/admin/promotion-packages').expect(401)
    await api.get('/api/admin/editorial-features').expect(401)
    await api.get('/api/admin/merchant-entitlements').expect(401)
    await api.get('/api/admin/merchandising/runs').expect(401)
  })

  it('returns category DTOs, prefers categoryCode and keeps the legacy label filter compatible', async () => {
    const networkCategoryId = await getActiveCategoryIdByLabel('网络节点')
    const rechargeCategoryId = await getActiveCategoryIdByLabel('充值卡密')
    const network = await createProduct('节点商品', networkCategoryId, '网络节点')
    await createProduct('卡密商品', rechargeCategoryId, '充值卡密')

    const byCode = await api.get('/api/products').query({ categoryCode: 'network-node' }).expect(200)
    expect(byCode.body.items.map((item: { id: number }) => item.id)).toEqual([network.id])
    expect(byCode.body.items[0].category).toEqual({
      id: networkCategoryId,
      code: 'network-node',
      label: '网络节点',
    })
    expect(byCode.body.items[0].type).toBe('网络节点')

    const legacy = await api.get('/api/products').query({ category: '网络节点' }).expect(200)
    expect(legacy.body.items.map((item: { id: number }) => item.id)).toEqual([network.id])
  })

  it('keeps an inactive historical category in the DTO but excludes it from an active code filter', async () => {
    const categoryId = await getActiveCategoryIdByLabel('网络节点')
    const product = await createProduct('历史商品', categoryId, '网络节点')
    await prisma.productCategory.update({ where: { id: categoryId }, data: { status: 'inactive' } })

    const unfiltered = await api.get('/api/products').expect(200)
    expect(unfiltered.body.items.find((item: { id: number }) => item.id === product.id)?.category)
      .toEqual({ id: categoryId, code: 'network-node', label: '网络节点' })

    const filtered = await api.get('/api/products').query({ categoryCode: 'network-node' }).expect(200)
    expect(filtered.body.items).toEqual([])
  })

  it('uses id DESC with hot=null before the first run and never exposes legacy isHot', async () => {
    const categoryId = await getActiveCategoryIdByLabel('网络节点')
    const legacyHot = await createProduct('旧热卖', categoryId, '网络节点', { isHot: true, sales: 999 })
    const newer = await createProduct('新商品', categoryId, '网络节点', { isHot: false, sales: 0 })

    const response = await api.get('/api/products').expect(200)
    expect(response.body.items.map((item: { id: number }) => item.id)).toEqual([newer.id, legacyHot.id])
    expect(response.body.items.every((item: Record<string, unknown>) => !('isHot' in item))).toBe(true)
    expect(response.body.items.map((item: { merchandising: { hot: unknown } }) => item.merchandising.hot))
      .toEqual([null, null])
  })

  it('orders by a completed run and keeps the cursor pinned when a newer run completes', async () => {
    const categoryId = await getActiveCategoryIdByLabel('网络节点')
    const first = await createProduct('第一件', categoryId, '网络节点')
    const second = await createProduct('第二件', categoryId, '网络节点')
    const third = await createProduct('第三件', categoryId, '网络节点')
    const oldCompletedAt = new Date('2026-08-11T00:00:00.000Z')
    const oldRun = await createCompletedRun(oldCompletedAt, [
      { productId: first.id, categoryId, effectiveOrderCount: 20, categoryRank: 1, isHot: true },
      { productId: second.id, categoryId, effectiveOrderCount: 10, categoryRank: 2, isHot: true },
      { productId: third.id, categoryId, effectiveOrderCount: 50, categoryRank: 3, isHot: false },
    ])

    const page1 = await api.get('/api/products').query({ pageSize: 2 }).expect(200)
    expect(page1.body.items.map((item: { id: number }) => item.id)).toEqual([first.id, second.id])
    expect(page1.body.items.map((item: { merchandising: { rankingRunId: string } }) => item.merchandising.rankingRunId))
      .toEqual([oldRun.id, oldRun.id])
    expect(page1.body.nextCursor).toEqual(expect.any(String))

    await createCompletedRun(new Date('2026-08-11T01:00:00.000Z'), [
      { productId: third.id, categoryId, effectiveOrderCount: 100, categoryRank: 1, isHot: true },
      { productId: second.id, categoryId, effectiveOrderCount: 2, categoryRank: 2, isHot: false },
      { productId: first.id, categoryId, effectiveOrderCount: 1, categoryRank: 3, isHot: false },
    ])

    const page2 = await api.get('/api/products')
      .query({ pageSize: 2, cursor: page1.body.nextCursor })
      .expect(200)
    expect(page2.body.items.map((item: { id: number }) => item.id)).toEqual([third.id])
    expect(page2.body.items[0].merchandising.rankingRunId).toBe(oldRun.id)

    const mismatch = await api.get('/api/products')
      .query({ pageSize: 2, categoryCode: 'network-node', cursor: page1.body.nextCursor })
      .expect(409)
    expect(mismatch.body.error.code).toBe('PRODUCT_CURSOR_EXPIRED')
  })
})
