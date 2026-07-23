import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import {
  createOrderStatusEvent,
  getProductFulfillmentMode,
  isInstantMode,
  normalizeOrderStatus,
  transitionOrderStatus,
} from './fulfillment.js'
import { serializeUserOrderDetail, serializeUserOrderList } from './serializers.js'
import { invalidateProductPublicCache } from '../products/cache.js'

// manual_service 商家履约 SLA：创建订单后 7 天内需交付，M3-S2 工作台高亮超时
const FULFILLMENT_SLA_MS = 7 * 24 * 60 * 60 * 1000

export async function createOrder(userId: number, productId: number) {
  const result = await prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw notFound('积分账户不存在')

    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw notFound('商品不存在')
    if (product.status !== 'active') throw badRequest('商品已下架')
    const deliveryMode = getProductFulfillmentMode(product.deliveryMode)

    if (deliveryMode === 'instant_fixed' && !product.fixedContent) {
      throw badRequest('商品暂不可购买，请联系商家')
    }
    if (deliveryMode !== 'instant_inventory' && product.stockMode === 'limited' && product.stock <= 0) {
      throw badRequest('库存不足，请稍后再试')
    }

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

    const isManual = deliveryMode === 'manual_service'

    // 积分流转规则（PRD §4.3.1）：
    // - instant_* 模式：即时扣减，PointLog 'out'，Settlement 'pending'
    // - manual_service：冻结积分（holdingPoints），不扣余额，Settlement 'holding'
    let orderHoldingPoints: number | null = null
    let orderFulfillmentDeadline: Date | null = null
    let newBalance = account.balance
    let settledSettlementStatus: 'pending' | 'holding' = 'pending'

    if (isManual) {
      // 虚拟服务订单：积分冻结，不扣减，仅记录 holdingPoints
      orderHoldingPoints = product.price
      orderFulfillmentDeadline = new Date(Date.now() + FULFILLMENT_SLA_MS)
      settledSettlementStatus = 'holding'
      // balance 不变，PointLog 留空（不写 'out'，因为积分未实际支出）
    } else {
      // 即时模式：立即扣减
      newBalance = account.balance - product.price
      await tx.pointAccount.update({
        where: { userId },
        data: { balance: newBalance },
      })
    }

    const order = await tx.order.create({
      data: {
        userId,
        productId,
        price: product.price,
        status: isInstantMode(deliveryMode) ? 'delivered' : 'pending',
        merchantId,
        commissionRate,
        commissionAmount,
        holdingPoints: orderHoldingPoints,
        fulfillmentDeadline: orderFulfillmentDeadline,
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
    let deliveryContentType: string | undefined

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
      deliveryContentType = 'text'

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: item.content,
          contentType: 'text',
          status: 'delivered',
          deliveredAt: new Date(),
        },
      })
    } else if (deliveryMode === 'instant_fixed') {
      deliveryContent = product.fixedContent!
      deliveryContentType = product.fixedContentType

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: product.fixedContent,
          contentType: product.fixedContentType,
          status: 'delivered',
          deliveredAt: new Date(),
        },
      })
    }

    // PointLog 仅在即时模式写入；manual_service 冻结阶段不产生支出日志
    if (!isManual) {
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
    }

    if (merchantId != null) {
      await tx.settlement.create({
        data: {
          merchantId,
          orderId: order.id,
          orderAmount: product.price,
          commissionRate,
          commissionAmount,
          settlementAmount: product.price - commissionAmount,
          status: settledSettlementStatus,
        },
      })
    }

    if (deliveryMode === 'instant_inventory') {
      await tx.product.update({
        where: { id: productId },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
    } else if (product.stockMode === 'limited') {
      // 条件更新防并发超卖：stock>0 才扣减，失败即售罄
      const updated = await tx.product.updateMany({
        where: { id: productId, stock: { gt: 0 } },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
      if (updated.count !== 1) throw badRequest('库存不足，请稍后再试')
    } else {
      await tx.product.update({
        where: { id: productId },
        data: { sales: { increment: 1 } },
      })
    }

    return {
      orderId: order.id,
      productName: product.name,
      price: product.price,
      status: normalizeOrderStatus(order.status),
      deliveryMode,
      deliveryContent,
      deliveryContentType,
      balanceAfter: newBalance,
      merchantId,
      merchantName,
    }
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

export async function getOrderDetail(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      delivery: { select: { status: true, content: true, contentType: true, publicNote: true, deliveredAt: true } },
      review: {
        select: { rating: true, comment: true, status: true, editableUntil: true, editedAt: true, createdAt: true },
      },
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
  const normalized = normalizeOrderStatus(order.status)
  return {
    ...serializeUserOrderDetail(order),
    review: order.review ?? null,
    canReview: !order.review && (normalized === 'delivered' || normalized === 'closed'),
  }
}

function buildUserOrderWhere(userId: number, status?: string): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { userId }
  if (!status) return where

  const normalizedStatus = normalizeOrderStatus(status)
  where.status = normalizedStatus === 'delivered'
    ? { in: ['delivered', 'completed'] }
    : normalizedStatus

  return where
}

export async function getUserOrders(userId: number, page = 1, pageSize = 20, status?: string) {
  const orders = await prisma.order.findMany({
    where: buildUserOrderWhere(userId, status),
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

async function assertUserOwnsOrder(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true },
  })
  if (!order) throw notFound('订单不存在')
}

export async function disputeOrder(orderId: number, userId: number) {
  await assertUserOwnsOrder(orderId, userId)
  await transitionOrderStatus({
    orderId,
    toStatus: 'disputed',
    actorRole: 'user',
    actorUserId: userId,
    action: 'user.dispute',
    publicNote: '用户发起争议',
  })

  return getOrderDetail(orderId, userId)
}

export async function closeOrder(orderId: number, userId: number) {
  // 用户确认关闭：积分正式扣减（若为 manual_service 冻结单）
  // PRD §4.3.1：delivered > 7 天自动 closed，积分正式扣减并触发 Settlement
  await assertUserOwnsOrder(orderId, userId)
  const result = await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, holdingPoints: true, status: true, productId: true },
    })
    if (!order) throw notFound('订单不存在')

    // 状态流转：delivered → closed
    const updated = await transitionOrderStatus(
      {
        orderId,
        toStatus: 'closed',
        actorRole: 'user',
        actorUserId: userId,
        action: 'user.close',
        publicNote: '用户确认关闭',
      },
      tx
    )

    // 若为冻结单（manual_service），扣减冻结积分并触发 Settlement 生效
    if (order.holdingPoints != null && order.holdingPoints > 0) {
      const account = await tx.pointAccount.findUnique({ where: { userId: order.userId } })
      if (!account) throw notFound('积分账户不存在')
      const newBalance = account.balance - order.holdingPoints
      await tx.pointAccount.update({
        where: { userId: order.userId },
        data: { balance: newBalance },
      })
      await tx.pointLog.create({
        data: {
          userId: order.userId,
          type: 'out',
          amount: order.holdingPoints,
          balanceAfter: newBalance,
          reason: `订单关闭扣款: #${order.id}`,
          orderId: order.id,
        },
      })
      // Settlement 从 holding 转为 pending，可被批量结算
      await tx.settlement.updateMany({
        where: { orderId: order.id, status: 'holding' },
        data: { status: 'pending' },
      })
    }

    await tx.order.update({
      where: { id: orderId },
      data: { confirmedAt: new Date() },
    })

    return updated
  })

  await invalidateProductPublicCache(result.productId, { list: 'coalesced' })
  return getOrderDetail(orderId, userId)
}
