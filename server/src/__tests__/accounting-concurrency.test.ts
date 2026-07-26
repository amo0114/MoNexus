import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { registerUser } from '../modules/auth/service.js'
import { resolveOrder } from '../modules/admin/service.js'
import { respondToOrderDispute } from '../modules/merchant/service.js'
import { closeOrder, createOrder, disputeOrder } from '../modules/orders/service.js'
import { checkin } from '../modules/points/service.js'
import { createProductWithOffer, createTestMerchant, createTestUser } from './helpers.js'

async function createFixedProduct(price: number, merchantId?: number) {
  return createProductWithOffer({
    data: {
      name: `并发固定商品-${price}`,
      type: '邀请码',
      price,
      status: 'active',
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'FIXED-CONCURRENT-CONTENT',
      merchantId,
    },
  })
}

async function createManualProduct(price: number, merchantId?: number) {
  return createProductWithOffer({
    data: {
      name: `并发人工服务-${price}`,
      type: '网络节点',
      price,
      status: 'active',
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      merchantId,
    },
  })
}

describe('accounting concurrency and terminal settlement', () => {
  it('does not overspend available points when fixed-content orders race', async () => {
    const { user } = await createTestUser('concurrent-fixed@test.local', 'pass123', 'user', 1000)
    const product = await createFixedProduct(800)

    const attempts = await Promise.allSettled([
      createOrder(user.id, product.id),
      createOrder(user.id, product.id),
    ])

    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1)
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      balance: 200,
      frozenBalance: 0,
    })
    expect(await prisma.pointLog.count({ where: { userId: user.id, type: 'out' } })).toBe(1)
  })

  it('assigns distinct available inventory to concurrent buyers instead of racing for the first item', async () => {
    const product = await prisma.product.create({
      data: {
        name: '并发库存领取商品',
        type: '邀请码',
        price: 100,
        status: 'active',
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
        stock: 4,
      },
    })
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '默认规格', price: 100, stock: 4 },
    })
    await prisma.inventoryItem.createMany({
      data: ['CONCURRENT-ITEM-1', 'CONCURRENT-ITEM-2', 'CONCURRENT-ITEM-3', 'CONCURRENT-ITEM-4']
        .map(content => ({ productId: product.id, offerId: offer.id, content })),
    })
    const buyers = await Promise.all(
      ['a', 'b', 'c', 'd'].map(suffix =>
        createTestUser(`concurrent-inventory-${suffix}@test.local`, 'pass123', 'user', 500)
      )
    )

    const attempts = await Promise.allSettled(buyers.map(({ user }) => createOrder(user.id, product.id)))
    expect(attempts.every(attempt => attempt.status === 'fulfilled')).toBe(true)

    const deliveries = attempts.map(attempt => {
      if (attempt.status !== 'fulfilled') throw attempt.reason
      return attempt.value.deliveryContent
    })
    expect(new Set(deliveries)).toEqual(new Set([
      'CONCURRENT-ITEM-1', 'CONCURRENT-ITEM-2', 'CONCURRENT-ITEM-3', 'CONCURRENT-ITEM-4',
    ]))
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
      // 即时库存扣减发生在 InventoryItem，Product.stock 不再是可售库存投影。
      stock: 4,
      sales: 4,
    })
    expect(await prisma.inventoryItem.count({ where: { productId: product.id, status: 'sold' } })).toBe(4)
  })

  it('reserves manual-service funds once and prevents a second order from reusing them', async () => {
    const { user } = await createTestUser('concurrent-manual@test.local', 'pass123', 'user', 1000)
    const product = await createManualProduct(800)

    const attempts = await Promise.allSettled([
      createOrder(user.id, product.id),
      createOrder(user.id, product.id),
    ])

    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      balance: 200,
      frozenBalance: 800,
    })
    expect(await prisma.pointLog.count({ where: { userId: user.id, type: 'hold' } })).toBe(1)
  })

  it('closes a held order once when the user submits the same close action concurrently', async () => {
    const { user } = await createTestUser('concurrent-close@test.local', 'pass123', 'user', 1000)
    const product = await createManualProduct(400)
    const { orderId } = await createOrder(user.id, product.id)
    await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } })

    const attempts = await Promise.allSettled([
      closeOrder(orderId, user.id),
      closeOrder(orderId, user.id),
    ])

    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      balance: 600,
      frozenBalance: 0,
    })
    expect(await prisma.pointLog.count({ where: { userId: user.id, orderId, type: 'out' } })).toBe(1)
    expect(await prisma.orderStatusEvent.count({ where: { orderId, toStatus: 'closed' } })).toBe(1)
  })

  it('refunds an instant order and voids its pending merchant settlement', async () => {
    const { merchant } = await createTestMerchant('instant-refund-merchant@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '即时退款商家',
    })
    const { user: buyer } = await createTestUser('instant-refund-buyer@test.local', 'pass123', 'user', 1000)
    const { user: admin } = await createTestUser('instant-refund-admin@test.local', 'pass123', 'admin')
    const product = await createFixedProduct(400, merchant.id)
    const { orderId } = await createOrder(buyer.id, product.id)

    await disputeOrder(orderId, buyer.id)
    await resolveOrder(admin.id, orderId, { result: 'refund', note: '并发回归测试' })

    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })).toMatchObject({
      balance: 1000,
      frozenBalance: 0,
    })
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ status: 'voided' })
    expect(await prisma.pointLog.findFirstOrThrow({ where: { userId: buyer.id, orderId, type: 'refund' } })).toMatchObject({
      amount: 400,
      balanceAfter: 1000,
    })
  })

  it('settles a held order when a merchant closes its dispute', async () => {
    const { merchant, user: merchantUser } = await createTestMerchant('merchant-close-merchant@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '争议关闭商家',
    })
    const { user: buyer } = await createTestUser('merchant-close-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createManualProduct(400, merchant.id)
    const { orderId } = await createOrder(buyer.id, product.id)
    await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } })

    await disputeOrder(orderId, buyer.id)
    await respondToOrderDispute(merchant.id, merchantUser.id, orderId, { resolution: 'close' })

    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })).toMatchObject({
      balance: 600,
      frozenBalance: 0,
    })
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ status: 'pending' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
      status: 'closed',
      holdingPoints: null,
      fundsHeld: false,
    })
  })

  it('preserves both concurrent invite rewards and returns a business error for the losing check-in', async () => {
    const { user: inviter } = await createTestUser('invite-race-inviter@test.local', 'pass123', 'user', 0)

    const registrations = await Promise.allSettled([
      registerUser('invite-race-one@test.local', 'pass123', inviter.inviteCode),
      registerUser('invite-race-two@test.local', 'pass123', inviter.inviteCode),
    ])
    expect(registrations.filter(result => result.status === 'fulfilled')).toHaveLength(2)

    const inviteLogs = await prisma.pointLog.findMany({
      where: { userId: inviter.id, reason: { contains: '邀请新用户' } },
    })
    const expectedBalance = inviteLogs.reduce((sum, log) => sum + log.amount, 0)
    expect(inviteLogs).toHaveLength(2)
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: inviter.id } })).balance)
      .toBe(expectedBalance)

    const checkins = await Promise.allSettled([checkin(inviter.id), checkin(inviter.id)])
    expect(checkins.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(checkins.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await prisma.checkinRecord.count({ where: { userId: inviter.id } })).toBe(1)
  })
})
