import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  createTestMerchant,
  createTestProduct,
  loginAsMerchant,
  authHeader,
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
  const base = Date.now() - contents.length * 60_000
  for (let i = 0; i < contents.length; i++) {
    await prisma.inventoryItem.create({
      data: {
        productId,
        content: contents[i],
        status: 'available',
        createdAt: new Date(base + i * 60_000),
      },
    })
  }
}

describe('POST /api/merchant/products/:id/inventory/void', () => {
  it('voids earliest available items, decrements stock and writes a void log', async () => {
    const { merchant, user, accessToken, product } = await setupMerchantWithProduct(
      'void-success@test.local'
    )
    await createTimedInventory(product.id, ['code-0', 'code-1', 'code-2'])
    await prisma.product.update({ where: { id: product.id }, data: { stock: 3 } })

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
    expect(updatedProduct?.stock).toBe(1)

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
    })
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
})

describe('GET /api/merchant/products/:id/inventory/logs', () => {
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
