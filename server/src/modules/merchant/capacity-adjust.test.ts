import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestUser,
  loginAs,
  loginAsMerchant,
} from '../../__tests__/helpers.js'

async function activeMerchant(email: string) {
  await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `商家-${email}`,
  })
  return (await loginAsMerchant(email, 'pass123')).accessToken
}

async function createLimitedProduct(token: string, deliveryMode: 'instant_fixed' | 'manual_service' = 'instant_fixed') {
  const body = deliveryMode === 'instant_fixed'
    ? {
        name: '限量固定内容', type: '邀请码', price: 100,
        deliveryMode, fixedContent: 'https://example.test/invite', fixedContentType: 'url',
        stockMode: 'limited',
      }
    : {
        name: '限量人工服务', type: '网络节点', price: 100,
        deliveryMode, stockMode: 'limited',
      }
  const res = await api.post('/api/merchant/products').set(authHeader(token)).send(body).expect(201)
  const productId = res.body.id as number
  // Catalog Ops：建品与可售量分离。草稿初始名额恒为 0，随后显式补充名额。
  await api.post(`/api/merchant/products/${productId}/capacity/adjust`).set(authHeader(token))
    .send({ delta: 3, reason: '初始化可售名额' }).expect(200)
  // 本文件包含一条下单扣减回归；发布门禁另有专门测试，这里直设 active
  // 只为构造“已发布且已有名额”的订单前置状态。
  await prisma.product.update({ where: { id: productId }, data: { status: 'active' } })
  return productId
}

describe('merchant limited product capacity adjustment', () => {
  it('adjusts fixed-content capacity atomically and records an attributed reason', async () => {
    const token = await activeMerchant('capacity-adjust@test.local')
    const productId = await createLimitedProduct(token)

    const increased = await api
      .post(`/api/merchant/products/${productId}/capacity/adjust`)
      .set(authHeader(token))
      .send({ delta: 5, reason: '新增可售邀请码配额' })
      .expect(200)
    expect(increased.body.stock).toBe(8)

    const decreased = await api
      .post(`/api/merchant/products/${productId}/capacity/adjust`)
      .set(authHeader(token))
      .send({ delta: -6, reason: '下架失效名额' })
      .expect(200)
    expect(decreased.body.stock).toBe(2)

    const [product, logs] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: productId } }),
      prisma.inventoryLog.findMany({ where: { productId }, orderBy: { id: 'asc' } }),
    ])
    expect(product.stock).toBe(2)
    expect(logs.map(log => ({ action: log.action, delta: log.delta, reason: log.reason }))).toEqual([
      { action: 'capacity_adjust', delta: 3, reason: '初始化可售名额' },
      { action: 'capacity_adjust', delta: 5, reason: '新增可售邀请码配额' },
      { action: 'capacity_adjust', delta: -6, reason: '下架失效名额' },
    ])
  })

  it('never permits a concurrent-safe decrement below the remaining capacity', async () => {
    const token = await activeMerchant('capacity-negative@test.local')
    const productId = await createLimitedProduct(token, 'manual_service')

    await api
      .post(`/api/merchant/products/${productId}/capacity/adjust`)
      .set(authHeader(token))
      .send({ delta: -4, reason: '错误调整' })
      .expect(400)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stock).toBe(3)
    expect(await prisma.inventoryLog.count({ where: { productId } })).toBe(1)
  })

  it('records a sale against the order when limited capacity is consumed', async () => {
    const token = await activeMerchant('capacity-sale-merchant@test.local')
    const productId = await createLimitedProduct(token)
    const { user } = await createTestUser('capacity-sale-buyer@test.local', 'pass123', 'user', 500)
    const buyer = await loginAs('capacity-sale-buyer@test.local', 'pass123')

    const created = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId })
      .expect(201)

    const [product, saleLog] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: productId } }),
      prisma.inventoryLog.findFirstOrThrow({ where: { productId, action: 'sale' } }),
    ])
    expect(product.stock).toBe(2)
    expect(saleLog).toMatchObject({
      action: 'sale',
      delta: -1,
      actorUserId: user.id,
      orderId: created.body.orderId,
      batchId: null,
    })
  })

  it('rejects capacity adjustment for immediate inventory and unlimited products', async () => {
    const token = await activeMerchant('capacity-mode@test.local')
    const immediate = await api.post('/api/merchant/products').set(authHeader(token))
      .send({ name: '逐条发货', type: '充值卡密', price: 10, deliveryMode: 'instant_inventory' })
      .expect(201)
    const unlimited = await api.post('/api/merchant/products').set(authHeader(token))
      .send({
        name: '不限量链接', type: '邀请码', price: 10, deliveryMode: 'instant_fixed',
        fixedContent: 'https://example.test/unlimited', fixedContentType: 'url', stockMode: 'unlimited',
      })
      .expect(201)

    await api.post(`/api/merchant/products/${immediate.body.id}/capacity/adjust`).set(authHeader(token))
      .send({ delta: 1, reason: '不应允许' }).expect(400)
    await api.post(`/api/merchant/products/${unlimited.body.id}/capacity/adjust`).set(authHeader(token))
      .send({ delta: 1, reason: '不应允许' }).expect(400)
  })
})
