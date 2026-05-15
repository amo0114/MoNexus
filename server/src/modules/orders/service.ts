import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import {
  createOrderStatusEvent,
  getProductFulfillmentMode,
  normalizeOrderStatus,
} from './fulfillment.js'
import { serializeUserOrderDetail, serializeUserOrderList } from './serializers.js'

export async function createOrder(userId: number, productId: number) {
  return prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw notFound('积分账户不存在')

    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw notFound('商品不存在')
    if (product.status !== 'active') throw badRequest('商品已下架')
    const deliveryMode = getProductFulfillmentMode(product.deliveryMode)

    if (account.balance < product.price) throw badRequest('积分不足')

    const item = deliveryMode === 'instant_inventory'
      ? await tx.inventoryItem.findFirst({
          where: { productId, status: 'available' },
          orderBy: { id: 'asc' },
        })
      : null
    if (deliveryMode === 'instant_inventory' && !item) {
      throw badRequest('库存不足，请稍后再试')
    }

    let merchantId: number | null = null
    let merchantName: string | null = null
    let commissionRate = 0
    let commissionAmount = 0

    if (product.merchantId != null) {
      const merchant = await tx.merchant.findUnique({ where: { id: product.merchantId } })
      if (!merchant || merchant.status !== 'active') throw badRequest('商家暂不可用')

      merchantId = merchant.id
      merchantName = merchant.name
      commissionRate = Number(merchant.commissionRate)
      commissionAmount = Math.floor(product.price * commissionRate)
    }

    const newBalance = account.balance - product.price

    await tx.pointAccount.update({
      where: { userId },
      data: { balance: newBalance },
    })

    const order = await tx.order.create({
      data: {
        userId,
        productId,
        price: product.price,
        status: deliveryMode === 'instant_inventory' ? 'delivered' : 'pending',
        merchantId,
        commissionRate,
        commissionAmount,
      },
    })

    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId: userId,
      actorRole: 'user',
      fromStatus: null,
      toStatus: order.status,
      action: `order.created.${deliveryMode}`,
    })

    let deliveryContent: string | undefined

    if (deliveryMode === 'instant_inventory') {
      if (!item) throw badRequest('库存不足，请稍后再试')

      const reservedItem = await tx.inventoryItem.updateMany({
        where: { id: item.id, status: 'available' },
        data: {
          status: 'sold',
          orderId: order.id,
          soldToUserId: userId,
          soldAt: new Date(),
        },
      })
      if (reservedItem.count !== 1) throw badRequest('库存不足，请稍后再试')

      deliveryContent = item.content

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: item.content,
          status: 'delivered',
          deliveredAt: new Date(),
        },
      })
    }

    await tx.pointLog.create({
      data: {
        userId,
        type: 'out',
        amount: product.price,
        balanceAfter: newBalance,
        reason: `兑换商品: ${product.name}`,
        orderId: order.id,
      },
    })

    if (merchantId != null) {
      await tx.settlement.create({
        data: {
          merchantId,
          orderId: order.id,
          orderAmount: product.price,
          commissionRate,
          commissionAmount,
          settlementAmount: product.price - commissionAmount,
          status: 'pending',
        },
      })
    }

    await tx.product.update({
      where: { id: productId },
      data: deliveryMode === 'instant_inventory'
        ? { stock: { decrement: 1 }, sales: { increment: 1 } }
        : { sales: { increment: 1 } },
    })

    return {
      orderId: order.id,
      productName: product.name,
      price: product.price,
      status: normalizeOrderStatus(order.status),
      deliveryMode,
      deliveryContent,
      balanceAfter: newBalance,
      merchantId,
      merchantName,
    }
  })
}

export async function getOrderDetail(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      delivery: { select: { status: true, content: true, publicNote: true, deliveredAt: true } },
      statusEvents: {
        select: {
          id: true,
          actorRole: true,
          fromStatus: true,
          toStatus: true,
          action: true,
          publicNote: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!order) throw notFound('订单不存在')
  return serializeUserOrderDetail(order)
}

export async function getUserOrders(userId: number, page = 1, pageSize = 20) {
  const orders = await prisma.order.findMany({
    where: { userId },
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      delivery: { select: { status: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
  return orders.map(serializeUserOrderList)
}
