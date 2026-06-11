import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, createTestUser, createTestMerchant, loginAs, authHeader } from './helpers.js'

async function createFixedProduct(merchantId: number, overrides: Record<string, unknown> = {}) {
  return prisma.product.create({
    data: {
      name: '固定内容商品',
      type: '邀请码',
      price: 100,
      stock: 0,
      status: 'active',
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'https://example.com/invite',
      fixedContentType: 'url',
      merchantId,
      ...overrides,
    },
  })
}

describe('createOrder for instant_fixed products', () => {
  it('delivers fixed content immediately without consuming InventoryItem', async () => {
    const { merchant } = await createTestMerchant('fixed-m1@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '固定内容商家',
    })
    await createTestUser('fixed-b1@test.local', 'buyer123', 'user', 5000)
    const product = await createFixedProduct(merchant.id)

    const buyer = await loginAs('fixed-b1@test.local', 'buyer123')
    const res = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)

    expect(res.body.status).toBe('delivered')
    expect(res.body.deliveryContent).toBe('https://example.com/invite')
    expect(res.body.deliveryContentType).toBe('url')

    const delivery = await prisma.deliveryRecord.findUnique({ where: { orderId: res.body.orderId } })
    expect(delivery?.content).toBe('https://example.com/invite')
    expect(delivery?.contentType).toBe('url')

    const after = await prisma.product.findUnique({ where: { id: product.id } })
    expect(after?.stock).toBe(0) // unlimited 不扣减
    expect(after?.sales).toBe(1)
    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(0)
  })

  it('decrements stock for limited instant_fixed and rejects when sold out', async () => {
    const { merchant } = await createTestMerchant('fixed-m2@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '限量固定商家',
    })
    await createTestUser('fixed-b2@test.local', 'buyer123', 'user', 5000)
    const product = await createFixedProduct(merchant.id, {
      stockMode: 'limited', stock: 1, fixedContentType: 'text', fixedContent: '固定文本内容',
    })

    const buyer = await loginAs('fixed-b2@test.local', 'buyer123')
    await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)

    const after = await prisma.product.findUnique({ where: { id: product.id } })
    expect(after?.stock).toBe(0)

    const second = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(400)
    expect(second.body.error.message).toContain('库存不足')
  })

  it('rejects ordering an instant_fixed product without fixedContent', async () => {
    const { merchant } = await createTestMerchant('fixed-m3@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '缺内容商家',
    })
    await createTestUser('fixed-b3@test.local', 'buyer123', 'user', 5000)
    const product = await createFixedProduct(merchant.id, { fixedContent: null })

    const buyer = await loginAs('fixed-b3@test.local', 'buyer123')
    const res = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(400)
    expect(res.body.error.message).toContain('暂不可购买')
  })
})
