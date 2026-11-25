import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  configureDefaultOffer,
  createTestProduct,
  createTestUser,
  loginAs,
  makeManualService,
} from '../../__tests__/helpers.js'

type ListItem = { id: number; name: string; price: number; instantDelivery: boolean }

async function collectAllPages(query: Record<string, string>, token?: string) {
  const names: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 10; guard += 1) {
    const req = api.get('/api/products').query({ ...query, pageSize: '2', ...(cursor ? { cursor } : {}) })
    const res = await (token ? req.set(authHeader(token)) : req).expect(200)
    names.push(...res.body.items.map((item: ListItem) => item.name))
    if (!res.body.hasMore) return names
    cursor = res.body.nextCursor
  }
  throw new Error('pagination did not terminate')
}

describe('GET /api/products list options', () => {
  it('sorts by price and sales across keyset pages', async () => {
    const mid = await createTestProduct('中价', 200)
    await createTestProduct('低价', 100)
    const high = await createTestProduct('高价', 300)
    await prisma.product.update({ where: { id: mid.id }, data: { sales: 50 } })
    await prisma.product.update({ where: { id: high.id }, data: { sales: 10 } })

    expect(await collectAllPages({ sort: 'price_asc' })).toEqual(['低价', '中价', '高价'])
    expect(await collectAllPages({ sort: 'price_desc' })).toEqual(['高价', '中价', '低价'])
    expect(await collectAllPages({ sort: 'sales' })).toEqual(['中价', '高价', '低价'])
  })

  it('rejects a cursor issued for another sort', async () => {
    await createTestProduct('甲', 100)
    await createTestProduct('乙', 200)
    await createTestProduct('丙', 300)
    const first = await api.get('/api/products').query({ pageSize: '2' }).expect(200)
    expect(first.body.hasMore).toBe(true)
    const res = await api.get('/api/products')
      .query({ pageSize: '2', sort: 'price_asc', cursor: first.body.nextCursor })
      .expect(409)
    expect(res.body.error.code).toBe('PRODUCT_CURSOR_EXPIRED')
  })

  it('derives instant delivery from every active offer', async () => {
    const instant = await createTestProduct('秒发', 100)
    const manual = await createTestProduct('人工', 100)
    await makeManualService(manual.id)
    const mixed = await createTestProduct('混合', 100)
    await prisma.offer.create({
      data: { productId: mixed.id, name: '人工规格', price: 100, stock: 0, stockMode: 'unlimited', deliveryMode: 'manual_service' },
    })

    const all = await api.get('/api/products').expect(200)
    const flags = Object.fromEntries(all.body.items.map((item: ListItem) => [item.id, item.instantDelivery]))
    expect(flags).toEqual({ [instant.id]: true, [manual.id]: false, [mixed.id]: false })

    const filtered = await api.get('/api/products').query({ instant: 'true' }).expect(200)
    expect(filtered.body.items.map((item: ListItem) => item.id)).toEqual([instant.id])
  })

  it('filters affordability by the caller balance, never a client value', async () => {
    const { user, password } = await createTestUser('afford@monexus.local', 'testpass123', 'user', 150)
    const cheap = await createTestProduct('可兑', 100)
    const pricey = await createTestProduct('不可兑', 300)
    // A cheaper active offer makes the product affordable even if its card price is not.
    const multi = await createTestProduct('多规格', 500)
    await prisma.offer.create({ data: { productId: multi.id, name: '小份', price: 120, stock: 5 } })
    const { accessToken } = await loginAs(user.email, password)

    const res = await api.get('/api/products')
      .query({ affordable: 'true', maxPrice: '999999' })
      .set(authHeader(accessToken))
      .expect(200)
    const ids = res.body.items.map((item: ListItem) => item.id)
    expect(ids).toContain(cheap.id)
    expect(ids).toContain(multi.id)
    expect(ids).not.toContain(pricey.id)

    // Guests have no balance: the flag is ignored rather than trusting anything client-side.
    const guest = await api.get('/api/products').query({ affordable: 'true' }).expect(200)
    expect(guest.body.items.map((item: ListItem) => item.id)).toContain(pricey.id)
  })

  it('drops cards whose public availability is unavailable', async () => {
    const available = await createTestProduct('有货', 100)
    const soldOut = await createTestProduct('售罄', 100, 0, [])
    const unlimited = await createTestProduct('不限', 100)
    await configureDefaultOffer(unlimited.id, { deliveryMode: 'manual_service', stock: 0, stockMode: 'unlimited' })

    const res = await api.get('/api/products').query({ inStock: 'true' }).expect(200)
    const ids = res.body.items.map((item: ListItem) => item.id)
    expect(ids).toEqual(expect.arrayContaining([available.id, unlimited.id]))
    expect(ids).not.toContain(soldOut.id)
  })
})
