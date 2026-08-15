import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  loginAsMerchant,
  authHeader,
  getDefaultOfferId,
} from '../../__tests__/helpers.js'

async function setupMerchantWithProduct(email: string, items: string[] = []) {
  const { user, merchant } = await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: '库存流水商家',
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  const product = await createTestProduct('库存流水商品', 100, items.length, items, merchant.id)
  return { user, merchant, accessToken, product }
}

async function createTimedInventory(productId: number, contents: string[]) {
  const offerId = await getDefaultOfferId(productId)
  const base = Date.now() - contents.length * 60_000
  for (let i = 0; i < contents.length; i++) {
    await prisma.inventoryItem.create({
      data: {
        productId,
        offerId,
        content: contents[i],
        status: 'available',
        createdAt: new Date(base + i * 60_000),
      },
    })
  }
}

describe('POST /api/merchant/products/:id/inventory/void', () => {
  it('voids earliest available items, derives remaining stock from items and writes a void log', async () => {
    const { merchant, user, accessToken, product } = await setupMerchantWithProduct(
      'void-success@test.local'
    )
    await createTimedInventory(product.id, ['code-0', 'code-1', 'code-2'])
    // 模拟历史投影漂移：即时库存的真实值只能来自可用 InventoryItem。
    await prisma.product.update({ where: { id: product.id }, data: { stock: 99 } })

    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 2, reason: '卡密失效' })
      .expect(200)

    expect(res.body).toMatchObject({ voided: 2, stock: 1 })

    const items = await prisma.inventoryItem.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(items.map(item => item.status)).toEqual(['void', 'void', 'available'])

    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } })
    expect(updatedProduct?.stock).toBe(99)

    const logs = await prisma.inventoryLog.findMany({ where: { productId: product.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      productId: product.id,
      merchantId: merchant.id,
      actorUserId: user.id,
      action: 'void',
      delta: -2,
      reason: '卡密失效',
    })
  })

  it('rejects when count exceeds available items without any change', async () => {
    const { accessToken, product } = await setupMerchantWithProduct(
      'void-insufficient@test.local',
      ['only-one']
    )

    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 2 })
      .expect(400)

    expect(res.body.error.code).toBe('BAD_REQUEST')

    const items = await prisma.inventoryItem.findMany({ where: { productId: product.id } })
    expect(items.map(item => item.status)).toEqual(['available'])

    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } })
    expect(updatedProduct?.stock).toBe(1)

    const logCount = await prisma.inventoryLog.count({ where: { productId: product.id } })
    expect(logCount).toBe(0)
  })

  it('never voids sold items', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('void-sold@test.local')
    // 最早的一条已售出，不能被作废
    await prisma.inventoryItem.create({
      data: {
        productId: product.id,
        offerId: await getDefaultOfferId(product.id),
        content: 'sold-secret',
        status: 'sold',
        createdAt: new Date(Date.now() - 3600_000),
      },
    })
    await createTimedInventory(product.id, ['avail-0'])
    await prisma.product.update({ where: { id: product.id }, data: { stock: 1 } })

    await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 2 })
      .expect(400)

    const soldItem = await prisma.inventoryItem.findFirst({
      where: { productId: product.id, content: 'sold-secret' },
    })
    expect(soldItem?.status).toBe('sold')

    const voided = await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 1 })
      .expect(200)

    expect(voided.body).toMatchObject({ voided: 1, stock: 0 })
    const soldAfter = await prisma.inventoryItem.findFirst({
      where: { productId: product.id, content: 'sold-secret' },
    })
    expect(soldAfter?.status).toBe('sold')
  })

  it('returns 404 when voiding another merchant product', async () => {
    const { product } = await setupMerchantWithProduct('void-owner@test.local', ['owner-code'])
    await createTestMerchant('void-foreign@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '外部商家',
    })
    const foreign = await loginAsMerchant('void-foreign@test.local', 'pass123')

    await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(foreign.accessToken))
      .send({ count: 1 })
      .expect(404)

    const item = await prisma.inventoryItem.findFirst({ where: { productId: product.id } })
    expect(item?.status).toBe('available')
  })

  it('rejects non-positive or non-integer count', async () => {
    const { accessToken, product } = await setupMerchantWithProduct(
      'void-bad-count@test.local',
      ['code-x']
    )

    for (const count of [0, -1, 1.5]) {
      await api
        .post(`/api/merchant/products/${product.id}/inventory/void`)
        .set(authHeader(accessToken))
        .send({ count })
        .expect(400)
    }
  })
})

describe('POST /api/merchant/products/:id/inventory (import log)', () => {
  it('writes an import InventoryLog in the same transaction', async () => {
    const { merchant, user, accessToken, product } = await setupMerchantWithProduct(
      'import-log@test.local'
    )

    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['import-a', 'import-b', 'import-c'] })
      .expect(200)

    const logs = await prisma.inventoryLog.findMany({ where: { productId: product.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      productId: product.id,
      merchantId: merchant.id,
      actorUserId: user.id,
      action: 'import',
      delta: 3,
      orderId: null,
    })
    expect(logs[0].batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('does not write logs when import is rejected', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('import-log-fail@test.local')

    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['dup', 'dup'] })
      .expect(400)

    const logCount = await prisma.inventoryLog.count({ where: { productId: product.id } })
    expect(logCount).toBe(0)
  })

  it('uses the database uniqueness guard when two imports race with the same content', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('import-race@test.local')
    const url = `/api/merchant/products/${product.id}/inventory`

    const results = await Promise.all([
      api.post(url).set(authHeader(accessToken)).send({ items: ['RACE-UNIQUE-CARD'] }),
      api.post(url).set(authHeader(accessToken)).send({ items: ['RACE-UNIQUE-CARD'] }),
    ])

    expect(results.map(result => result.status).sort()).toEqual([200, 400])
    const rejected = results.find(result => result.status === 400)
    expect(rejected?.body.error.message).toBe('库存导入包含重复项')

    const [items, productAfter, logs] = await Promise.all([
      prisma.inventoryItem.findMany({ where: { productId: product.id } }),
      prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      prisma.inventoryLog.findMany({ where: { productId: product.id } }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ content: 'RACE-UNIQUE-CARD', status: 'available' })
    expect(productAfter.stock).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ action: 'import', delta: 1 })
  })

  it('rejects imports beyond the bounded row limit before writing anything', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('import-size-limit@test.local')
    const items = Array.from({ length: 1_001 }, (_, index) => `LIMIT-${index}`)

    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items })
      .expect(400)

    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(0)
    expect(await prisma.inventoryLog.count({ where: { productId: product.id } })).toBe(0)
  })

  it('rejects a single inventory item that exceeds the content limit', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('import-item-length-limit@test.local')

    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['x'.repeat(5_001)] })
      .expect(400)

    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(0)
  })
})

describe('GET /api/merchant/products/:id/inventory/logs', () => {
  it('includes a sale and its order reference without ever returning the delivery content', async () => {
    const { merchant, accessToken, product } = await setupMerchantWithProduct(
      'logs-sale-owner@test.local',
      ['merchant-sale-secret']
    )
    await createTestUser('logs-sale-buyer@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('logs-sale-buyer@test.local', 'pass123')
    const order = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const res = await api
      .get(`/api/merchant/products/${product.id}/inventory/logs`)
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({ total: 1, page: 1 })
    expect(res.body.items[0]).toMatchObject({
      action: 'sale',
      delta: -1,
      orderId: order.body.orderId,
      merchantId: merchant.id,
    })
    expect(res.body.items[0].batchId).toBeNull()
    expect(JSON.stringify(res.body)).not.toContain('merchant-sale-secret')
  })

  it('returns paginated logs in reverse chronological order without inventory content', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('logs-list@test.local')

    await api
      .post(`/api/merchant/products/${product.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['log-secret-1', 'log-secret-2'] })
      .expect(200)
    await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 1, reason: '人工作废' })
      .expect(200)

    const res = await api
      .get(`/api/merchant/products/${product.id}/inventory/logs`)
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({ total: 2, page: 1 })
    expect(res.body.items).toHaveLength(2)
    expect(res.body.items[0]).toMatchObject({ action: 'void', delta: -1, reason: '人工作废' })
    expect(res.body.items[1]).toMatchObject({ action: 'import', delta: 2 })

    // 卡密内容绝不能出现在流水响应中
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('log-secret-1')
    expect(serialized).not.toContain('log-secret-2')

    const page2 = await api
      .get(`/api/merchant/products/${product.id}/inventory/logs`)
      .query({ page: 2, pageSize: 1 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(page2.body).toMatchObject({ total: 2, page: 2, pageSize: 1 })
    expect(page2.body.items).toHaveLength(1)
    expect(page2.body.items[0]).toMatchObject({ action: 'import', delta: 2 })
  })

  it('clamps pageSize to maxPageSize config', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('logs-clamp@test.local')

    const res = await api
      .get(`/api/merchant/products/${product.id}/inventory/logs`)
      .query({ pageSize: 10000 })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.pageSize).toBeLessThanOrEqual(100)
  })

  it('returns 404 for another merchant product', async () => {
    const { product } = await setupMerchantWithProduct('logs-owner@test.local')
    await createTestMerchant('logs-foreign@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '外部商家',
    })
    const foreign = await loginAsMerchant('logs-foreign@test.local', 'pass123')

    await api
      .get(`/api/merchant/products/${product.id}/inventory/logs`)
      .set(authHeader(foreign.accessToken))
      .expect(404)
  })
})

// P4a F4：库存作废与名额调整的显式 offerId 定向回归——多规格商品上
// 必须只动指定规格，绝不波及默认规格。
describe('explicit offerId targeting for void & capacity adjust', () => {
  it('voids only the selected offer inventory, leaving the default offer pool intact', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('void-offer-scope@test.local', ['DEF-1', 'DEF-2'])
    const defaultOfferId = await getDefaultOfferId(product.id)
    const extra = await prisma.offer.create({
      data: { productId: product.id, name: '高级卡密档', price: 300 },
    })
    await prisma.inventoryItem.createMany({
      data: ['EX-1', 'EX-2', 'EX-3'].map(content => ({
        productId: product.id, offerId: extra.id, content, status: 'available',
      })),
    })

    const res = await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 2, reason: '规格定向作废', offerId: extra.id })
      .expect(200)
    expect(res.body.voided).toBe(2)

    expect(await prisma.inventoryItem.count({ where: { offerId: extra.id, status: 'available' } })).toBe(1)
    expect(await prisma.inventoryItem.count({ where: { offerId: defaultOfferId, status: 'available' } })).toBe(2)
    // 作废流水挂在被定向的规格上。
    const log = await prisma.inventoryLog.findFirstOrThrow({
      where: { productId: product.id, action: 'void' },
    })
    expect(log.offerId).toBe(extra.id)
  })

  it('adjusts capacity only on the selected limited offer', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('capacity-offer-scope@test.local')
    const defaultOfferId = await getDefaultOfferId(product.id)
    const limited = await prisma.offer.create({
      data: {
        productId: product.id, name: '限量服务档', price: 500,
        deliveryMode: 'manual_service', stockMode: 'limited', stock: 5,
      },
    })

    const res = await api
      .post(`/api/merchant/products/${product.id}/capacity/adjust`)
      .set(authHeader(accessToken))
      .send({ delta: 3, reason: '追加名额', offerId: limited.id })
      .expect(200)
    expect(res.body.stock).toBe(8)

    expect((await prisma.offer.findUniqueOrThrow({ where: { id: limited.id } })).stock).toBe(8)
    // 默认规格（即时库存档）不受影响。
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: defaultOfferId } })).stock).toBe(0)

    // 即时库存规格不能走名额调整（必须逐条导入/作废）。
    const rejected = await api
      .post(`/api/merchant/products/${product.id}/capacity/adjust`)
      .set(authHeader(accessToken))
      .send({ delta: 3, reason: '误操作', offerId: defaultOfferId })
      .expect(400)
    expect(rejected.body.error.message).toBeTruthy()
  })

  it('returns 404 for an offerId that belongs to another product on both endpoints', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('offer-scope-foreign@test.local', ['F-1'])
    const otherProduct = await createTestProduct('别家规格商品', 100, 1, ['O-1'])
    const foreignOfferId = await getDefaultOfferId(otherProduct.id)

    await api
      .post(`/api/merchant/products/${product.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 1, offerId: foreignOfferId })
      .expect(404)
    await api
      .post(`/api/merchant/products/${product.id}/capacity/adjust`)
      .set(authHeader(accessToken))
      .send({ delta: 1, reason: '越界', offerId: foreignOfferId })
      .expect(404)
  })
})

// T-CAT-BE-004：Offer-first URL 是 P0 权威写路径。这里使用真实 HTTP +
// PostgreSQL，覆盖 preview→confirm 重算、规格隔离、审计字段和并发最终裁决。
describe('Offer-first availability operations', () => {
  it('projects available inventory separately for every Offer and the Product aggregate', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('offer-first-list@test.local', ['DEFAULT-1', 'DEFAULT-2'])
    const second = await prisma.offer.create({
      data: { productId: product.id, name: '第二库存池', price: 200, deliveryMode: 'instant_inventory' },
    })
    await prisma.inventoryItem.createMany({
      data: ['SECOND-1', 'SECOND-2', 'SECOND-3'].map(content => ({
        productId: product.id,
        offerId: second.id,
        content,
        status: 'available',
      })),
    })

    const response = await api.get('/api/merchant/products').set(authHeader(accessToken)).expect(200)
    const row = response.body.items.find((item: { id: number }) => item.id === product.id)
    expect(row.availableStock).toBe(5)
    const byId = new Map(row.offers.map((offer: { id: number }) => [offer.id, offer]))
    expect(byId.get(await getDefaultOfferId(product.id))).toMatchObject({ stock: 2, availableStock: 2 })
    expect(byId.get(second.id)).toMatchObject({ stock: 3, availableStock: 3 })

    // The dedicated Offer endpoint must expose the same inventory-derived
    // projection as the product list; otherwise the Offer-first UI regresses
    // to the persisted legacy stock value after an import.
    const offersResponse = await api
      .get(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)
    const offersById = new Map(offersResponse.body.map((offer: { id: number }) => [offer.id, offer]))
    expect(offersById.get(await getDefaultOfferId(product.id))).toMatchObject({ stock: 2, availableStock: 2 })
    expect(offersById.get(second.id)).toMatchObject({ stock: 3, availableStock: 3 })
  })

  it('previews without writes, re-analyses on confirm, and exposes offer-scoped audit without content', async () => {
    const { user, accessToken, product } = await setupMerchantWithProduct('offer-first-import@test.local')
    const offer = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '独立卡密池',
        price: 200,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
        stock: 0,
      },
    })
    const url = `/api/merchant/products/${product.id}/offers/${offer.id}/inventory`

    const preview = await api.post(`${url}/preview`).set(authHeader(accessToken))
      .send({ items: ['OFFER-SECRET-1', 'OFFER-SECRET-2'] }).expect(200)
    expect(preview.body).toMatchObject({ totalRows: 2, validRows: 2, canImport: true })
    expect(await prisma.inventoryItem.count({ where: { offerId: offer.id } })).toBe(0)

    const imported = await api.post(url).set(authHeader(accessToken))
      .send({ items: ['OFFER-SECRET-1', 'OFFER-SECRET-2'] }).expect(200)
    expect(imported.body.imported).toBe(2)

    // preview 后数据库状态改变；confirm 必须在事务内重算，不能信任旧 preview。
    await api.post(url).set(authHeader(accessToken))
      .send({ items: ['OFFER-SECRET-1'] }).expect(400)

    const logs = await api.get(`/api/merchant/products/${product.id}/inventory/logs`)
      .set(authHeader(accessToken)).expect(200)
    expect(logs.body.items[0]).toMatchObject({
      productId: product.id,
      offerId: offer.id,
      actorUserId: user.id,
      action: 'import',
      delta: 2,
    })
    expect(logs.body.items[0].batchId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(JSON.stringify(logs.body)).not.toContain('OFFER-SECRET')
  })

  it('voids only the URL offer and returns both offer and product availability totals', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('offer-first-void@test.local', ['DEFAULT-1', 'DEFAULT-2'])
    const defaultOfferId = await getDefaultOfferId(product.id)
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '第二库存池', price: 200, deliveryMode: 'instant_inventory' },
    })
    await prisma.inventoryItem.createMany({
      data: ['SECOND-1', 'SECOND-2', 'SECOND-3'].map(content => ({
        productId: product.id,
        offerId: offer.id,
        content,
        status: 'available',
      })),
    })

    const response = await api
      .post(`/api/merchant/products/${product.id}/offers/${offer.id}/inventory/void`)
      .set(authHeader(accessToken))
      .send({ count: 2, reason: '规格池作废' })
      .expect(200)
    expect(response.body).toMatchObject({
      offerId: offer.id,
      voided: 2,
      availableStock: 1,
      productAvailableStock: 3,
      stock: 1,
    })
    expect(await prisma.inventoryItem.count({ where: { offerId: defaultOfferId, status: 'available' } })).toBe(2)
  })

  it('rejects a URL offer that belongs to a different product on every merchant operation', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('offer-first-scope@test.local')
    const foreignProduct = await createTestProduct('外部商品', 100, 0, [])
    const foreignOfferId = await getDefaultOfferId(foreignProduct.id)
    const base = `/api/merchant/products/${product.id}/offers/${foreignOfferId}`

    await api.post(`${base}/inventory/preview`).set(authHeader(accessToken)).send({ items: ['x'] }).expect(404)
    await api.post(`${base}/inventory`).set(authHeader(accessToken)).send({ items: ['x'] }).expect(404)
    await api.post(`${base}/inventory/void`).set(authHeader(accessToken)).send({ count: 1 }).expect(404)
    await api.post(`${base}/capacity/adjust`).set(authHeader(accessToken))
      .send({ delta: 1, reason: '越权' }).expect(404)
  })

  it('uses the unique index as final arbiter for 50 concurrent imports of the same secret', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('offer-first-race@test.local')
    const offerId = await getDefaultOfferId(product.id)
    const url = `/api/merchant/products/${product.id}/offers/${offerId}/inventory`
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => api.post(url).set(authHeader(accessToken)).send({ items: ['ONLY-ONCE'] })),
    )

    expect(responses.filter(response => response.status === 200)).toHaveLength(1)
    expect(responses.filter(response => response.status === 400)).toHaveLength(49)
    expect(await prisma.inventoryItem.count({ where: { offerId, content: 'ONLY-ONCE' } })).toBe(1)
    expect(await prisma.inventoryLog.count({ where: { offerId, action: 'import' } })).toBe(1)
  }, 30_000)

  it('keeps limited capacity non-negative under 50 concurrent decrements', async () => {
    const { accessToken, product } = await setupMerchantWithProduct('offer-first-capacity@test.local')
    const offerId = await getDefaultOfferId(product.id)
    await prisma.offer.update({
      where: { id: offerId },
      data: { deliveryMode: 'manual_service', stockMode: 'limited', stock: 25 },
    })
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stockMode: 'limited', stock: 25 },
    })
    const url = `/api/merchant/products/${product.id}/offers/${offerId}/capacity/adjust`
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => api.post(url).set(authHeader(accessToken))
        .send({ delta: -1, reason: '并发缩减' })),
    )
    expect(responses.filter(response => response.status === 200)).toHaveLength(25)
    expect(responses.filter(response => response.status === 400)).toHaveLength(25)
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(0)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(0)
    expect(await prisma.inventoryLog.count({ where: { offerId, action: 'capacity_adjust' } })).toBe(25)
  }, 30_000)

  it('allows admin preview/confirm on the same offer contract and records offer in both audit trails', async () => {
    const { user: admin } = await createTestUser('offer-first-admin@test.local', 'pass123', 'admin')
    const adminAuth = await loginAs('offer-first-admin@test.local', 'pass123')
    const { merchant } = await createTestMerchant('offer-first-admin-merchant@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '被补货商家',
    })
    const product = await createTestProduct('管理员补货商品', 100, 0, [], merchant.id)
    const offerId = await getDefaultOfferId(product.id)
    const url = `/api/admin/products/${product.id}/offers/${offerId}/inventory`

    await api.post(`${url}/preview`).set(authHeader(adminAuth.accessToken))
      .send({ items: ['ADMIN-OFFER-1'] }).expect(200)
    const confirmed = await api.post(url).set(authHeader(adminAuth.accessToken))
      .send({ items: ['ADMIN-OFFER-1'] }).expect(200)
    expect(confirmed.body.imported).toBe(1)

    const inventoryLog = await prisma.inventoryLog.findFirstOrThrow({
      where: { productId: product.id, offerId, actorUserId: admin.id, action: 'import' },
    })
    expect(inventoryLog.batchId).not.toBeNull()
    const adminLog = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'product', targetId: product.id },
    })
    expect(adminLog.detail).toContain(`offerId=${offerId}`)
    expect(adminLog.detail).not.toContain('ADMIN-OFFER-1')
  })
})
