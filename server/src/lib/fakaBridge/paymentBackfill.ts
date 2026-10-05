import { prisma } from '../prisma.js'
import { captureHeldOrder } from '../../modules/orders/accounting.js'

export type FakaPaymentBackfillResult = {
  orderId: number
  status: 'eligible' | 'captured' | 'skipped'
  reason: string
  amount?: number
}

type BackfillOptions = {
  apply?: boolean
  operator?: string
}

/** Preview by default; explicit application never dispatches Xboard or releases merchant funds. */
export async function backfillFakaOrderPayment(
  orderId: number,
  options: BackfillOptions = {}
): Promise<FakaPaymentBackfillResult> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Invalid order ID')
  const operator = options.operator?.trim()
  if (options.apply && (!operator || operator.length > 160 || /[\r\n\x00-\x1f]/.test(operator))) {
    throw new Error('Applying a backfill requires an operator reference of 1-160 characters')
  }

  return prisma.$transaction(async transaction => {
    if (options.apply) {
      // Match the fulfillment/refund lock order; never act on a pre-preview snapshot.
      await transaction.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    } else {
      await transaction.$executeRaw`SET TRANSACTION READ ONLY`
    }
    const order = await transaction.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        price: true,
        status: true,
        holdingPoints: true,
        fundsHeld: true,
        delivery: { select: { status: true, deliveredAt: true } },
        fakaBridgeTask: {
          select: { status: true, completedAt: true, cancelRequested: true, revokeStatus: true },
        },
        settlement: { select: { status: true } },
      },
    })
    const skip = (reason: string): FakaPaymentBackfillResult => ({ orderId, status: 'skipped', reason })
    if (!order) return skip('order_not_found')
    if (order.status !== 'delivered') return skip('order_not_delivered')
    if (!order.fakaBridgeTask) return skip('not_xboard_order')
    if (!order.fundsHeld && order.holdingPoints == null) return skip('no_active_reservation')
    if (!order.fundsHeld || order.holdingPoints !== order.price || order.price <= 0) {
      return skip('reservation_amount_mismatch')
    }
    const task = order.fakaBridgeTask
    if (task.status !== 'succeeded' || !task.completedAt || task.cancelRequested || task.revokeStatus != null) {
      return skip('xboard_success_not_confirmed')
    }
    if (order.delivery?.status !== 'delivered' || !order.delivery.deliveredAt) {
      return skip('delivery_not_confirmed')
    }
    if (order.settlement && order.settlement.status !== 'holding') {
      return skip('merchant_settlement_not_held')
    }
    const logs = await transaction.pointLog.findMany({
      where: { orderId, userId: order.userId, type: { in: ['hold', 'out', 'release', 'refund'] } },
      select: { type: true, amount: true },
    })
    if (logs.some(log => log.type !== 'hold')) return skip('existing_payment_or_return')
    if (logs.length !== 1 || logs[0].amount !== order.price) return skip('hold_ledger_mismatch')

    if (options.apply) {
      await transaction.$queryRaw`SELECT "id" FROM "PointAccount" WHERE "userId" = ${order.userId} FOR UPDATE`
    }
    const account = await transaction.pointAccount.findUnique({
      where: { userId: order.userId },
      select: { frozenBalance: true },
    })
    // Shared frozen balance must cover every order reservation, not just this one.
    const reservations = await transaction.order.aggregate({
      where: { userId: order.userId, fundsHeld: true, holdingPoints: { gt: 0 } },
      _sum: { holdingPoints: true },
    })
    if (!account || account.frozenBalance < (reservations._sum.holdingPoints ?? order.price)) {
      return skip('account_reservation_mismatch')
    }
    if (!options.apply) return { orderId, status: 'eligible', reason: 'confirmed_delivery_with_held_payment', amount: order.price }

    await captureHeldOrder(transaction, order, `Xboard 历史交付补扣: #${orderId}`)
    await transaction.orderStatusEvent.create({
      data: {
        orderId,
        actorRole: 'system',
        fromStatus: 'delivered',
        toStatus: 'delivered',
        action: 'system.faka_bridge.payment_backfill',
        publicNote: 'Xboard 已交付订单的冻结积分已转为支付扣款',
        internalNote: `Operator reference: ${operator}`,
      },
    })
    return { orderId, status: 'captured', reason: 'historical_payment_captured', amount: order.price }
  }, { isolationLevel: 'Serializable' })
}

/** Bounded discovery is preview-only. Applying always requires an explicit order ID list. */
export async function listFakaPaymentBackfillCandidates(limit = 100): Promise<number[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be between 1 and 1000')
  const orders = await prisma.order.findMany({
    where: {
      status: 'delivered',
      fundsHeld: true,
      holdingPoints: { gt: 0 },
      fakaBridgeTask: { status: 'succeeded' },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: limit,
  })
  return orders.map(order => order.id)
}
