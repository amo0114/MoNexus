import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  createProductWithOffer,
  configureDefaultOffer,
  getDefaultOfferId,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'

// P5.5 T4：退款回补库存策略。所有场景走真实端点（下单/争议/仲裁/拒单），
// 断言库存条目、容量、销量计数器与 InventoryLog 流水在退款事务内的净效果。

async function setupMerchantAndBuyer(prefix: string) {
  const { merchant } = await createTestMerchant(`${prefix}-merchant@test.local`, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `${prefix}商家`,
  })
  await createTestUser(`${prefix}-buyer@test.local`, 'buyer123', 'user', 5000)
  const buyer = await loginAs(`${prefix}-buyer@test.local`, 'buyer123')
  return { merchant, buyer }
}

async function loginAdmin(prefix: string) {
  await createTestUser(`${prefix}-admin@test.local`, 'admin123', 'admin')
  return loginAs(`${prefix}-admin@test.local`, 'admin123')
}

async function resolveRefund(adminToken: string, orderId: number) {
  return api
    .post(`/api/admin/orders/${orderId}/resolve`)
    .set(authHeader(adminToken))
    .send({ result: 'refund', note: '策略测试退款' })
    .expect(200)
}

describe('refund inventory policy (P5.5 T4)', () => {
  it('instant_inventory dispute refund: voids the sold key, nets sales, never restores stock', async () => {
    const { merchant, buyer } = await setupMerchantAndBuyer('rip-inv')
    const product = await createTestProduct('即时库存退款品', 100, 1, ['RIP-KEY-001'], merchant.id)
    const offerId = await getDefaultOfferId(product.id)

    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    // 下单后基线：唯一一张卡密已售出，可用量 0
    const availableBefore = await prisma.inventoryItem.count({
      where: { offerId, status: 'available' },
    })
    expect(availableBefore).toBe(0)

    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)

    const admin = await loginAdmin('rip-inv')
    await resolveRefund(admin.accessToken, orderId)

    // 卡密 sold → void：交付即泄密，绝不回到 available
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { orderId } })
    expect(item.status).toBe('void')
    const availableAfter = await prisma.inventoryItem.count({
      where: { offerId, status: 'available' },
    })
    expect(availableAfter).toBe(0)

    // 同一订单的 sale 与 refund_void 流水并存（orderId 已非唯一）
    const logs = await prisma.inventoryLog.findMany({ where: { orderId }, orderBy: { id: 'asc' } })
    expect(logs).toHaveLength(2)
    expect(logs[0].action).toBe('sale')
    expect(logs[0].delta).toBe(-1)
    const refundLog = logs[1]
    expect(refundLog.action).toBe('refund_void')
    expect(refundLog.delta).toBe(0)
    expect(refundLog.orderId).toBe(orderId)
    expect(refundLog.offerId).toBe(offerId)

    // 销量净值：退款后计数器回落
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.sales).toBe(0)
    const dbProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(dbProduct.sales).toBe(0)
  })

  it('instant_fixed limited-stock dispute refund: nets sales but never restocks revealed content', async () => {
    const { merchant, buyer } = await setupMerchantAndBuyer('rip-fixed')
    const product = await createProductWithOffer({
      data: {
        name: '固定内容退款品',
        type: '邀请码',
        price: 150,
        stock: 5,
        status: 'active',
        deliveryMode: 'instant_fixed',
        stockMode: 'limited',
        fixedContent: 'RIP-FIXED-SECRET',
        fixedContentType: 'text',
        merchantId: merchant.id,
      },
    })
    const offerId = await getDefaultOfferId(product.id)

    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)

    const admin = await loginAdmin('rip-fixed')
    await resolveRefund(admin.accessToken, orderId)

    // 固定内容已泄露：容量保持消耗（下单扣减后的 4），不回补
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.stock).toBe(4)
    expect(offer.sales).toBe(0)
    const dbProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(dbProduct.stock).toBe(4)
    expect(dbProduct.sales).toBe(0)

    const restockLogs = await prisma.inventoryLog.findMany({
      where: { orderId, action: 'refund_restock' },
    })
    expect(restockLogs).toHaveLength(0)
  })

  it('manual_service limited capacity rejected while pending: restocks capacity and nets sales', async () => {
    const { merchant, buyer } = await setupMerchantAndBuyer('rip-manual-pend')
    const product = await createTestProduct('人工限量服务', 200, 0, [], merchant.id)
    await configureDefaultOffer(product.id, {
      deliveryMode: 'manual_service',
      stockMode: 'limited',
      stock: 3,
    })
    const offerId = await getDefaultOfferId(product.id)

    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    // 下单后名额被占用
    const offerAfterOrder = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offerAfterOrder.stock).toBe(2)
    expect(offerAfterOrder.sales).toBe(1)

    const merchantLogin = await loginAsMerchant('rip-manual-pend-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/reject`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)

    // 未交付即拒单：名额回补、销量净减
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.stock).toBe(3)
    expect(offer.sales).toBe(0)
    const dbProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(dbProduct.stock).toBe(3)
    expect(dbProduct.sales).toBe(0)

    const logs = await prisma.inventoryLog.findMany({ where: { orderId }, orderBy: { id: 'asc' } })
    expect(logs).toHaveLength(2)
    expect(logs[0].action).toBe('sale')
    expect(logs[1].action).toBe('refund_restock')
    expect(logs[1].delta).toBe(1)
    expect(logs[1].offerId).toBe(offerId)
  })

  it('manual_service disputed refund after delivery: nets sales without restocking consumed capacity', async () => {
    const { merchant, buyer } = await setupMerchantAndBuyer('rip-manual-disp')
    const product = await createTestProduct('人工争议服务', 250, 0, [], merchant.id)
    await configureDefaultOffer(product.id, {
      deliveryMode: 'manual_service',
      stockMode: 'limited',
      stock: 3,
    })
    const offerId = await getDefaultOfferId(product.id)

    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    const merchantLogin = await loginAsMerchant('rip-manual-disp-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'manual-delivered' })
      .expect(200)
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)

    const admin = await loginAdmin('rip-manual-disp')
    await resolveRefund(admin.accessToken, orderId)

    // 已交付的服务名额保持消耗：不回补，只做销量净减
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.stock).toBe(2)
    expect(offer.sales).toBe(0)
    const dbProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(dbProduct.stock).toBe(2)
    expect(dbProduct.sales).toBe(0)

    const restockLogs = await prisma.inventoryLog.findMany({
      where: { orderId, action: 'refund_restock' },
    })
    expect(restockLogs).toHaveLength(0)
  })

  it('sales floor: refund with counters already at 0 succeeds and stays at 0', async () => {
    const { merchant, buyer } = await setupMerchantAndBuyer('rip-floor')
    const product = await createTestProduct('脏数据退款品', 100, 1, ['RIP-FLOOR-001'], merchant.id)
    const offerId = await getDefaultOfferId(product.id)

    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)

    // 模拟历史脏数据：销量计数器已经是 0，退款时 gt: 0 防负必须静默跳过
    await prisma.offer.update({ where: { id: offerId }, data: { sales: 0 } })
    await prisma.product.update({ where: { id: product.id }, data: { sales: 0 } })

    const admin = await loginAdmin('rip-floor')
    await resolveRefund(admin.accessToken, orderId)

    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.sales).toBe(0)
    const dbProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(dbProduct.sales).toBe(0)

    // 退款其余效果不受计数器脏数据影响：卡密仍被报废
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { orderId } })
    expect(item.status).toBe('void')
  })
})
