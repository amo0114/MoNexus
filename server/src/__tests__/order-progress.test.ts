import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  loginAsMerchant,
  makeManualService,
} from './helpers.js'

/**
 * P6b：商家履约进度更新（POST /api/merchant/orders/:id/progress）。
 * 决策 ③：进度只追加 OrderStatusEvent（from=to='processing'），不改订单状态。
 */

async function seedManualOrder(tag: string) {
  const { merchant } = await createTestMerchant(`${tag}-merchant@test.local`, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `进度商家-${tag}`,
  })
  await createTestUser(`${tag}-buyer@test.local`, 'pass123', 'user', 5000)
  const product = await createTestProduct(`进度服务-${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)

  const buyer = await loginAs(`${tag}-buyer@test.local`, 'pass123')
  const created = await api
    .post('/api/orders')
    .set(authHeader(buyer.accessToken))
    .send({ productId: product.id })
    .expect(201)
  const orderId = created.body.orderId as number

  const merchantLogin = await loginAsMerchant(`${tag}-merchant@test.local`, 'pass123')
  return { merchant, product, orderId, buyer, merchantLogin }
}

async function startFulfillment(orderId: number, merchantToken: string) {
  await api
    .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
    .set(authHeader(merchantToken))
    .send({})
    .expect(200)
}

describe('POST /api/merchant/orders/:id/progress', () => {
  it('writes a merchant.progress event with publicNote and does not change order status', async () => {
    const { orderId, buyer, merchantLogin } = await seedManualOrder('prog-happy')
    await startFulfillment(orderId, merchantLogin.accessToken)

    const res = await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '已完成 50%，预计明天交付' })
      .expect(200)
    expect(res.body).toEqual({ ok: true })

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('processing')

    const events = await prisma.orderStatusEvent.findMany({
      where: { orderId, action: 'merchant.progress' },
    })
    expect(events).toHaveLength(1)
    expect(events[0].fromStatus).toBe('processing')
    expect(events[0].toStatus).toBe('processing')
    expect(events[0].actorRole).toBe('merchant')
    expect(events[0].publicNote).toBe('已完成 50%，预计明天交付')

    // 买家详情时间线包含进度事件：publicNote 可见，契约仅六字段
    // （无事件行 id / 无操作人用户 id）。
    const detail = await api
      .get(`/api/orders/${orderId}`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    const progressEvent = detail.body.timeline.find(
      (e: { action: string }) => e.action === 'merchant.progress'
    )
    expect(progressEvent).toBeDefined()
    expect(progressEvent.publicNote).toBe('已完成 50%，预计明天交付')
    expect(progressEvent.actorRole).toBe('merchant')
    expect(progressEvent.fromStatus).toBe('processing')
    expect(progressEvent.toStatus).toBe('processing')
    expect(Object.keys(progressEvent).sort()).toEqual(
      ['action', 'actorRole', 'createdAt', 'fromStatus', 'publicNote', 'toStatus']
    )
  })

  it('returns 404 for foreign or nonexistent orders (anti-enumeration)', async () => {
    const { orderId, merchantLogin } = await seedManualOrder('prog-foreign')
    await startFulfillment(orderId, merchantLogin.accessToken)

    await createTestMerchant('prog-other-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '别家商家',
    })
    const other = await loginAsMerchant('prog-other-merchant@test.local', 'pass123')

    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(other.accessToken))
      .send({ note: '越权进度' })
      .expect(404)
    await api
      .post('/api/merchant/orders/999999/progress')
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '不存在的订单' })
      .expect(404)

    const events = await prisma.orderStatusEvent.findMany({
      where: { action: 'merchant.progress' },
    })
    expect(events).toHaveLength(0)
  })

  it('rejects non-processing orders with 400', async () => {
    const { orderId, merchantLogin } = await seedManualOrder('prog-pending')

    // pending：尚未接单
    const res = await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '还没接单就发进度' })
      .expect(400)
    expect(res.body.error.message).toBe('仅履约中的人工服务订单可更新进度')

    // delivered：已交付
    await startFulfillment(orderId, merchantLogin.accessToken)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'done' })
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '交付后发进度' })
      .expect(400)
  })

  it('rejects non-manual_service orders with 400', async () => {
    const { merchant } = await createTestMerchant('prog-instant-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '即时商家',
    })
    const { user } = await createTestUser('prog-instant-buyer@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('即时商品', 100, 3, ['i1', 'i2', 'i3'], merchant.id)
    // 直接落库构造异常态：即时快照订单被人为置于 processing，仍不许发进度。
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        merchantId: merchant.id,
        price: 100,
        status: 'processing',
        deliveryModeSnapshot: 'instant_inventory',
      },
    })
    const merchantLogin = await loginAsMerchant('prog-instant-merchant@test.local', 'pass123')

    const res = await api
      .post(`/api/merchant/orders/${order.id}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '即时订单不该有进度' })
      .expect(400)
    expect(res.body.error.message).toBe('仅履约中的人工服务订单可更新进度')
  })

  it('rate limits the 7th progress update within an hour (6 allowed)', async () => {
    const { orderId, merchantLogin } = await seedManualOrder('prog-rate')
    await startFulfillment(orderId, merchantLogin.accessToken)

    for (let i = 1; i <= 6; i++) {
      await api
        .post(`/api/merchant/orders/${orderId}/progress`)
        .set(authHeader(merchantLogin.accessToken))
        .send({ note: `进度 ${i}/6` })
        .expect(200)
    }
    const res = await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '第 7 条应被限流' })
      .expect(429)
    expect(res.body.error.code).toBe('PROGRESS_RATE_LIMITED')

    const events = await prisma.orderStatusEvent.count({
      where: { orderId, action: 'merchant.progress' },
    })
    expect(events).toBe(6)

    // 一小时前的旧进度不占额度：把一条回拨 2 小时后再次放行。
    const oldest = await prisma.orderStatusEvent.findFirstOrThrow({
      where: { orderId, action: 'merchant.progress' },
      orderBy: { id: 'asc' },
    })
    await prisma.orderStatusEvent.update({
      where: { id: oldest.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })
    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '旧额度释放后的进度' })
      .expect(200)
  })

  it('exposes post_progress in availableActions for processing manual orders', async () => {
    const { orderId, merchantLogin } = await seedManualOrder('prog-actions')

    const pending = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(pending.body.availableActions).not.toContain('post_progress')

    await startFulfillment(orderId, merchantLogin.accessToken)
    const processing = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(processing.body.availableActions).toEqual(['deliver', 'post_progress'])
  })

  it('validates the note body (empty / overlong / unknown keys)', async () => {
    const { orderId, merchantLogin } = await seedManualOrder('prog-validate')
    await startFulfillment(orderId, merchantLogin.accessToken)

    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '   ' })
      .expect(400)
    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: 'x'.repeat(501) })
      .expect(400)
    await api
      .post(`/api/merchant/orders/${orderId}/progress`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ note: '合法进度', internalNote: '不在契约里' })
      .expect(400)
  })
})
