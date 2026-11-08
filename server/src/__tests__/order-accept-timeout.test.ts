import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { __runAcceptTimeoutBatchForTests } from '../modules/orders/acceptTimeoutCron.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs, loginAsMerchant, makeManualService } from './helpers.js'

async function manualOrder() {
  const tag = randomUUID().slice(0, 8)
  const { merchant } = await createTestMerchant(`accept-m-${tag}@test.local`, 'pass123', { role: 'merchant', status: 'active', name: `接单商家${tag}` })
  const { user } = await createTestUser(`accept-b-${tag}@test.local`, 'buyer123', 'user', 1000)
  const product = await createTestProduct(`人工接单${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)
  const buyer = await loginAs(`accept-b-${tag}@test.local`, 'buyer123')
  const merchantLogin = await loginAsMerchant(`accept-m-${tag}@test.local`, 'pass123')
  const created = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
  return { orderId: created.body.orderId as number, user, buyer, merchantLogin }
}

const points = (userId: number) => prisma.pointAccount.findUniqueOrThrow({ where: { userId }, select: { balance: true, frozenBalance: true } })

describe('unaccepted order cancellation', () => {
  it('freezes the accept deadline and lets the buyer cancel with points released once', async () => {
    const { orderId, user, buyer } = await manualOrder()
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    const hours = (order.acceptBy!.getTime() - order.createdAt.getTime()) / 3_600_000
    expect(hours).toBeCloseTo(24, 1)
    expect(await points(user.id)).toEqual({ balance: 700, frozenBalance: 300 })

    const res = await api.post(`/api/orders/${orderId}/cancel`).set(authHeader(buyer.accessToken)).expect(200)
    expect(res.body).toMatchObject({ status: 'refunded', resolutionReason: 'buyer_cancelled' })
    expect(await points(user.id)).toEqual({ balance: 1000, frozenBalance: 0 })
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ status: 'voided' })

    // A retried request returns the same result and releases nothing twice.
    await api.post(`/api/orders/${orderId}/cancel`).set(authHeader(buyer.accessToken)).expect(200)
    expect(await prisma.pointLog.count({ where: { orderId, type: 'release' } })).toBe(1)
  })

  it('lets exactly one of a concurrent accept and cancel win', async () => {
    const { orderId, user, buyer, merchantLogin } = await manualOrder()
    const [cancel, start] = await Promise.all([
      api.post(`/api/orders/${orderId}/cancel`).set(authHeader(buyer.accessToken)),
      api.post(`/api/merchant/orders/${orderId}/fulfillment/start`).set(authHeader(merchantLogin.accessToken)).send({}),
    ])
    expect([cancel.status, start.status].filter(status => status === 200)).toHaveLength(1)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe(cancel.status === 200 ? 'refunded' : 'processing')
    expect(await points(user.id)).toEqual(cancel.status === 200 ? { balance: 1000, frozenBalance: 0 } : { balance: 700, frozenBalance: 300 })
  })

  it('blocks a late accept and cancels on timeout, leaving legacy pending orders alone', async () => {
    const expired = await manualOrder()
    const legacy = await manualOrder()
    await prisma.order.update({ where: { id: expired.orderId }, data: { acceptBy: new Date(Date.now() - 60_000) } })
    await prisma.order.update({ where: { id: legacy.orderId }, data: { acceptBy: null } })

    await api.post(`/api/merchant/orders/${expired.orderId}/fulfillment/start`)
      .set(authHeader(expired.merchantLogin.accessToken)).send({}).expect(409)

    expect(await __runAcceptTimeoutBatchForTests()).toBe(1)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: expired.orderId } }))
      .toMatchObject({ status: 'refunded', resolutionReason: 'accept_timeout' })
    expect(await points(expired.user.id)).toEqual({ balance: 1000, frozenBalance: 0 })

    expect((await prisma.order.findUniqueOrThrow({ where: { id: legacy.orderId } })).status).toBe('pending')
    await api.post(`/api/orders/${legacy.orderId}/cancel`).set(authHeader(legacy.buyer.accessToken)).expect(409)
  })

  it('hides other buyers orders and refuses to cancel once accepted', async () => {
    const mine = await manualOrder()
    const other = await manualOrder()
    await api.post(`/api/orders/${mine.orderId}/cancel`).set(authHeader(other.buyer.accessToken)).expect(404)
    await api.post(`/api/merchant/orders/${mine.orderId}/fulfillment/start`).set(authHeader(mine.merchantLogin.accessToken)).send({}).expect(200)
    await api.post(`/api/orders/${mine.orderId}/cancel`).set(authHeader(mine.buyer.accessToken)).expect(409)
  })
})
