import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestUser,
  getDefaultOfferId,
  loginAs,
} from '../../__tests__/helpers.js'

async function adminToken(email: string) {
  const { user } = await createTestUser(email, 'pass123', 'admin')
  return { adminId: user.id, token: (await loginAs(email, 'pass123')).accessToken }
}

async function createPlatformManual(token: string, stockMode: 'limited' | 'unlimited' = 'limited') {
  const res = await api.post('/api/admin/products').set(authHeader(token)).send({
    name: `平台人工服务-${stockMode}`,
    type: '网络节点',
    price: 100,
    deliveryMode: 'manual_service',
    stockMode,
  }).expect(201)
  const productId = res.body.id as number
  return { productId, offerId: await getDefaultOfferId(productId) }
}

const capacityUrl = (productId: number, offerId: number) =>
  `/api/admin/products/${productId}/offers/${offerId}/capacity/adjust`

describe('admin platform offer capacity', () => {
  it('lets an admin give a limited platform manual offer capacity, with both audit trails', async () => {
    const { adminId, token } = await adminToken('offer-capacity-admin@test.local')
    const { productId, offerId } = await createPlatformManual(token)

    const added = await api.post(capacityUrl(productId, offerId)).set(authHeader(token))
      .send({ delta: 4, reason: '十月名额' })
      .expect(200)
    expect(added.body.stock).toBe(4)

    const reduced = await api.post(capacityUrl(productId, offerId)).set(authHeader(token))
      .send({ delta: -1, reason: '导师请假一次' })
      .expect(200)
    expect(reduced.body.stock).toBe(3)

    const [offer, product, logs, adminLogs] = await Promise.all([
      prisma.offer.findUniqueOrThrow({ where: { id: offerId } }),
      prisma.product.findUniqueOrThrow({ where: { id: productId } }),
      prisma.inventoryLog.findMany({ where: { productId }, orderBy: { id: 'asc' } }),
      prisma.adminLog.findMany({ where: { targetId: productId, action: '调整名额' }, orderBy: { id: 'asc' } }),
    ])
    expect(offer.stock).toBe(3)
    expect(product.stock).toBe(3)
    expect(logs.map(log => ({ action: log.action, delta: log.delta, merchantId: log.merchantId, actorUserId: log.actorUserId }))).toEqual([
      { action: 'capacity_adjust', delta: 4, merchantId: null, actorUserId: adminId },
      { action: 'capacity_adjust', delta: -1, merchantId: null, actorUserId: adminId },
    ])
    expect(adminLogs).toHaveLength(2)
    expect(adminLogs[1].detail).toContain('导师请假一次')
  })

  it('makes a capacity-backed platform offer purchasable and consumes one unit per order', async () => {
    const { token } = await adminToken('offer-capacity-sale-admin@test.local')
    const { productId, offerId } = await createPlatformManual(token)
    await api.post(capacityUrl(productId, offerId)).set(authHeader(token))
      .send({ delta: 1, reason: '仅一个名额' })
      .expect(200)
    // Publication readiness has its own suite; set active to reach checkout.
    await prisma.product.update({ where: { id: productId }, data: { status: 'active' } })
    await createTestUser('offer-capacity-buyer@test.local', 'pass123', 'user', 500)
    const buyer = await loginAs('offer-capacity-buyer@test.local', 'pass123')

    await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId }).expect(201)
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(0)

    // Sold out: the next order is refused instead of overselling.
    const second = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId })
    expect(second.status).toBeGreaterThanOrEqual(400)
    expect(await prisma.order.count({ where: { productId } })).toBe(1)
  })

  it('never lets a decrease go below the remaining capacity', async () => {
    const { token } = await adminToken('offer-capacity-negative-admin@test.local')
    const { productId, offerId } = await createPlatformManual(token)
    await api.post(capacityUrl(productId, offerId)).set(authHeader(token))
      .send({ delta: 2, reason: '初始' })
      .expect(200)

    await api.post(capacityUrl(productId, offerId)).set(authHeader(token))
      .send({ delta: -3, reason: '超减' })
      .expect(400)

    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(2)
    expect(await prisma.adminLog.count({ where: { targetId: productId, action: '调整名额' } })).toBe(1)
  })

  it('leaves merchant products, unlimited offers and foreign offers untouched', async () => {
    const { token } = await adminToken('offer-capacity-guard-admin@test.local')
    const { merchant } = await createTestMerchant('offer-capacity-guard-merchant@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '名额商家',
    })
    const merchantProduct = await prisma.product.create({
      data: {
        name: '商家人工服务', type: '网络节点', price: 100, status: 'active', merchantId: merchant.id,
        categoryId: (await prisma.productCategory.findFirstOrThrow()).id,
        deliveryMode: 'manual_service', stockMode: 'limited',
        offers: { create: { name: '默认规格', price: 100, isDefault: true, deliveryMode: 'manual_service', stockMode: 'limited' } },
      },
      include: { offers: true },
    })
    const unlimited = await createPlatformManual(token, 'unlimited')
    const limited = await createPlatformManual(token)

    const merchantRes = await api.post(capacityUrl(merchantProduct.id, merchantProduct.offers[0].id))
      .set(authHeader(token)).send({ delta: 1, reason: '越权' })
    expect(merchantRes.status).toBe(400)
    expect(merchantRes.body.error.message).toBe('商家商品的名额由商家调整')

    await api.post(capacityUrl(unlimited.productId, unlimited.offerId)).set(authHeader(token))
      .send({ delta: 1, reason: '不限量' })
      .expect(400)
    await api.post(capacityUrl(limited.productId, unlimited.offerId)).set(authHeader(token))
      .send({ delta: 1, reason: '错配规格' })
      .expect(404)
    await api.post(capacityUrl(limited.productId, limited.offerId)).set(authHeader(token))
      .send({ delta: 0, reason: '零调整' })
      .expect(400)

    expect((await prisma.offer.findUniqueOrThrow({ where: { id: merchantProduct.offers[0].id } })).stock).toBe(0)
    expect(await prisma.inventoryLog.count()).toBe(0)
  })

  it('is admin-only', async () => {
    const { token } = await adminToken('offer-capacity-owner-admin@test.local')
    const { productId, offerId } = await createPlatformManual(token)
    await createTestUser('offer-capacity-user@test.local', 'pass123', 'user')
    const user = await loginAs('offer-capacity-user@test.local', 'pass123')

    const res = await api.post(capacityUrl(productId, offerId)).set(authHeader(user.accessToken))
      .send({ delta: 1, reason: '普通用户' })
    expect(res.status).toBe(403)
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(0)
  })
})
