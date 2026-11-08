import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { __runAutoCloseBatchForTests } from '../modules/orders/cron.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs, loginAsMerchant, makeManualService } from './helpers.js'

const DAY = 24 * 3_600_000

async function setAutoCloseDays(value: number) {
  await prisma.systemConfig.upsert({ where: { key: 'autoCloseDays' }, create: { key: 'autoCloseDays', value }, update: { value } })
}

async function deliveredManualOrder() {
  const tag = randomUUID().slice(0, 8)
  const { merchant } = await createTestMerchant(`acc-m-${tag}@test.local`, 'pass123', { role: 'merchant', status: 'active', name: `验收商家${tag}` })
  await createTestUser(`acc-b-${tag}@test.local`, 'buyer123', 'user', 1000)
  const product = await createTestProduct(`人工验收${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)
  const buyer = await loginAs(`acc-b-${tag}@test.local`, 'buyer123')
  const seller = await loginAsMerchant(`acc-m-${tag}@test.local`, 'pass123')
  const created = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
  const orderId = created.body.orderId as number
  await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`).set(authHeader(seller.accessToken)).send({}).expect(200)
  await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`).set(authHeader(seller.accessToken)).send({ deliveryContent: '已交付' }).expect(200)
  return orderId
}

const order = (id: number) => prisma.order.findUniqueOrThrow({ where: { id } })

describe('acceptance window frozen at delivery', () => {
  it('keeps the delivered order on its own deadline when autoCloseDays changes later', async () => {
    await setAutoCloseDays(7)
    const orderId = await deliveredManualOrder()
    const deliveredAt = (await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })).deliveredAt!
    expect((await order(orderId)).acceptanceBy!.getTime() - deliveredAt.getTime()).toBeCloseTo(7 * DAY, -4)

    // Shortening the setting must not close an order delivered under the old one.
    await prisma.deliveryRecord.update({ where: { orderId }, data: { deliveredAt: new Date(Date.now() - 2 * DAY) } })
    await setAutoCloseDays(1)
    await __runAutoCloseBatchForTests()
    expect((await order(orderId)).status).toBe('delivered')

    await prisma.order.update({ where: { id: orderId }, data: { acceptanceBy: new Date(Date.now() - 60_000) } })
    await __runAutoCloseBatchForTests()
    expect(await order(orderId)).toMatchObject({ status: 'closed' })
    await setAutoCloseDays(7)
  })

  it('starts the window at checkout for instant orders', async () => {
    await setAutoCloseDays(7)
    const tag = randomUUID().slice(0, 8)
    await createTestUser(`acc-i-${tag}@test.local`, 'buyer123', 'user', 1000)
    const product = await createTestProduct(`即时验收${tag}`, 100, 1, [`CARD-${tag}`])
    const buyer = await loginAs(`acc-i-${tag}@test.local`, 'buyer123')
    const created = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
    const instant = await order(created.body.orderId)
    expect(instant.status).toBe('delivered')
    expect(instant.acceptanceBy!.getTime() - instant.createdAt.getTime()).toBeCloseTo(7 * DAY, -4)
  })
})
