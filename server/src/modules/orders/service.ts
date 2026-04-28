import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'

export async function createOrder(userId: number, productId: number) {
  return prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw notFound('积分账户不存在')

    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw notFound('商品不存在')
    if (product.status !== 'active') throw badRequest('商品已下架')

    if (account.balance < product.price) throw badRequest('积分不足')

    const item = await tx.inventoryItem.findFirst({
      where: { productId, status: 'available' },
      orderBy: { id: 'asc' },
    })
    if (!item) throw badRequest('库存不足，请稍后再试')

    const newBalance = account.balance - product.price

    await tx.pointAccount.update({
      where: { userId },
      data: { balance: newBalance },
    })

    const order = await tx.order.create({
      data: { userId, productId, price: product.price, status: 'completed' },
    })

    await tx.inventoryItem.update({
      where: { id: item.id },
      data: {
        status: 'sold',
        orderId: order.id,
        soldToUserId: userId,
        soldAt: new Date(),
      },
    })

    await tx.deliveryRecord.create({
      data: {
        orderId: order.id,
        userId,
        productId,
        content: item.content,
        status: 'delivered',
      },
    })

    await tx.pointLog.create({
      data: {
        userId,
        type: 'out',
        amount: product.price,
        balanceAfter: newBalance,
        reason: `兑换商品: ${product.name}`,
      },
    })

    await tx.product.update({
      where: { id: productId },
      data: { stock: { decrement: 1 }, sales: { increment: 1 } },
    })

    return {
      orderId: order.id,
      productName: product.name,
      price: product.price,
      deliveryContent: item.content,
      balanceAfter: newBalance,
    }
  })
}

export async function getOrderDetail(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      product: { select: { name: true, icon: true, type: true } },
      delivery: { select: { content: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return order
}

export async function getUserOrders(userId: number) {
  return prisma.order.findMany({
    where: { userId },
    include: {
      product: { select: { name: true, icon: true, type: true } },
      delivery: { select: { content: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
}
