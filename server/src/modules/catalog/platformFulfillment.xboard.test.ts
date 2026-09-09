import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { createTestUser } from '../../__tests__/helpers.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'
import {
  deliverPlatformOrder,
  postPlatformProgress,
  rejectPlatformOrder,
  startPlatformFulfillment,
} from './platformFulfillment.js'

const FAKA_OVERRIDE_MESSAGE = '外部开通订单不能由平台人工替代交付'

let serial = 0
function uniqEmail(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now()}-${serial}@test.local`
}

async function seedActors() {
  const admin = await createTestUser(uniqEmail('plat-ff-admin'), 'pass123', 'admin')
  const buyer = await createTestUser(uniqEmail('plat-ff-buyer'), 'pass123', 'user')
  const categoryId = await getActiveNetworkNodeCategoryId()
  return { admin, buyer, categoryId }
}

async function seedPlatformOrder(input: {
  buyerId: number
  buyerEmail: string
  categoryId: number
  status?: string
  fakaOffer?: boolean
  withTask?: boolean
  bookingDate?: Date | null
  sku?: string
  name?: string
  stockMode?: 'limited' | 'unlimited'
  stock?: number
  sales?: number
}) {
  const stockMode = input.stockMode ?? 'unlimited'
  const stock = input.stock ?? 0
  const sales = input.sales ?? 0
  const product = await prisma.product.create({
    data: {
      name: input.name ?? (input.fakaOffer ? 'Xboard 平台开通' : '平台人工服务'),
      type: '网络节点',
      categoryId: input.categoryId,
      price: 100,
      status: 'active',
      deliveryMode: 'manual_service',
      stockMode,
      stock,
      sales,
      merchantId: null,
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '默认规格',
      isDefault: true,
      price: 100,
      deliveryMode: 'manual_service',
      stockMode,
      stock,
      sales,
      ...(input.fakaOffer
        ? {
            externalIntegration: 'faka_bridge',
            externalSku: input.sku ?? `xboard-plat-${serial}-${product.id}`,
          }
        : {}),
    },
  })
  const order = await prisma.order.create({
    data: {
      userId: input.buyerId,
      productId: product.id,
      offerId: offer.id,
      price: 100,
      status: input.status ?? 'pending',
      merchantId: null,
      deliveryModeSnapshot: 'manual_service',
      productNameSnapshot: product.name,
      holdingPoints: 100,
      fundsHeld: true,
      bookingDate: input.bookingDate ?? null,
    },
  })
  if (input.withTask) {
    await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: input.buyerEmail,
        skuSnapshot: offer.externalSku ?? input.sku ?? 'aster-basic-monthly',
        periodSnapshot: 'monthly',
      },
    })
  }
  return { order, product, offer }
}

async function expectFakaOverrideRejected(run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({
    status: 400,
    message: FAKA_OVERRIDE_MESSAGE,
  })
}

describe('platform fulfillment vs Xboard/FakaBridge', () => {
  it('delivers a true platform-owned manual_service order', async () => {
    const { admin, buyer, categoryId } = await seedActors()
    const { order } = await seedPlatformOrder({
      buyerId: buyer.user.id,
      buyerEmail: buyer.user.email,
      categoryId,
    })
    const { order: appointment } = await seedPlatformOrder({
      buyerId: buyer.user.id,
      buyerEmail: buyer.user.email,
      categoryId,
      name: '平台预约人工',
      bookingDate: new Date('2026-09-15T00:00:00.000Z'),
    })

    await startPlatformFulfillment(admin.user.id, order.id)
    const delivered = await deliverPlatformOrder(admin.user.id, order.id, {
      content: '平台人工交付内容',
    })
    expect(delivered).toEqual({ id: order.id, status: 'delivered' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'delivered',
    })
    expect(await prisma.deliveryRecord.findUnique({ where: { orderId: order.id } })).toMatchObject({
      content: '平台人工交付内容',
    })

    await startPlatformFulfillment(admin.user.id, appointment.id)
    await expect(
      deliverPlatformOrder(admin.user.id, appointment.id, { content: '预约日人工交付' }),
    ).resolves.toEqual({ id: appointment.id, status: 'delivered' })
  })

  it('rejects FakaBridge start/progress/deliver/reject when snapshot is manual_service', async () => {
    const { admin, buyer, categoryId } = await seedActors()
    const { order } = await seedPlatformOrder({
      buyerId: buyer.user.id,
      buyerEmail: buyer.user.email,
      categoryId,
      fakaOffer: true,
      withTask: true,
    })
    const { order: offerOnly } = await seedPlatformOrder({
      buyerId: buyer.user.id,
      buyerEmail: buyer.user.email,
      categoryId,
      fakaOffer: true,
      withTask: false,
      sku: `xboard-offer-only-${serial}`,
    })
    const { order: taskOnly } = await seedPlatformOrder({
      buyerId: buyer.user.id,
      buyerEmail: buyer.user.email,
      categoryId,
      fakaOffer: false,
      withTask: true,
      sku: `xboard-orphan-task-${serial}`,
    })

    await expectFakaOverrideRejected(() => startPlatformFulfillment(admin.user.id, order.id))
    await expectFakaOverrideRejected(() =>
      postPlatformProgress(admin.user.id, order.id, '假装已开通'),
    )
    await expectFakaOverrideRejected(() =>
      deliverPlatformOrder(admin.user.id, order.id, { content: '绕过外部开通' }),
    )
    await expectFakaOverrideRejected(() =>
      rejectPlatformOrder(admin.user.id, order.id, '人工拒单替代交付'),
    )
    await expectFakaOverrideRejected(() =>
      deliverPlatformOrder(admin.user.id, offerOnly.id, { content: '无任务也不可人工交付' }),
    )
    await expectFakaOverrideRejected(() => startPlatformFulfillment(admin.user.id, taskOnly.id))

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe('pending')
    expect(await prisma.deliveryRecord.count({ where: { orderId: order.id } })).toBe(0)
  })

  it('restocks limited manual_service quota when admin rejects a pending platform order', async () => {
    const { admin, buyer, categoryId } = await seedActors()
    const { order, product, offer } = await seedPlatformOrder({
      buyerId: buyer.user.id,
      buyerEmail: buyer.user.email,
      categoryId,
      stockMode: 'limited',
      stock: 0,
      sales: 1,
    })

    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
      stock: 0,
      sales: 1,
    })
    expect(await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({
      stock: 0,
      sales: 1,
    })
    await prisma.pointAccount.update({
      where: { userId: buyer.user.id },
      data: { balance: { decrement: 100 }, frozenBalance: { increment: 100 } },
    })

    const rejected = await rejectPlatformOrder(admin.user.id, order.id, '平台拒单回补名额')
    expect(rejected).toEqual({ id: order.id, status: 'refunded' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'refunded',
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
      stock: 1,
      sales: 0,
    })
    expect(await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({
      stock: 1,
      sales: 0,
    })
  })
})
