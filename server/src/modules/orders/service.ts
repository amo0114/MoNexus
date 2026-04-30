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
        status: 'completed',
        merchantId,
        commissionRate,
        commissionAmount,
      },
    })

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
      data: { stock: { decrement: 1 }, sales: { increment: 1 } },
    })

    return {
      orderId: order.id,
      productName: product.name,
      price: product.price,
      deliveryContent: item.content,
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
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true } },
      delivery: { select: { status: true, content: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return order
}

export async function getUserOrders(userId: number, page = 1, pageSize = 20) {
  return prisma.order.findMany({
    where: { userId },
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true } },
      delivery: { select: { status: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
}
