import { Prisma } from '@prisma/client'
import { badRequest, conflict, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { lockAccountsInTx, orderPaymentComposition } from '../wallet/index.js'
import { reverseForAfterSalesInTx, voidUnsettledInTx } from '../merchantFinance/index.js'
import { refundPaidOrder } from './accounting.js'
import { createOrderStatusEvent } from './fulfillment.js'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Admin full refund of a closed order. The order stays closed (terminal); the
 * case records the refund decision, and merchantFinance records the earning
 * reversal. Only full refunds exist in this batch: no client-chosen amounts.
 */
const orderSelect = {
  id: true,
  userId: true,
  price: true,
  status: true,
  merchantId: true,
  settlement: { select: { id: true, status: true, settlementAmount: true, commissionAmount: true, batchItem: { select: { batchId: true } } } },
  fakaBridgeTask: { select: { status: true, revokeStatus: true } },
  fulfillmentJob: { select: { status: true } },
  merchant: { select: { userId: true } },
} satisfies Prisma.OrderSelect

type CaseOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>

/**
 * External entitlements must be provably revoked before points are returned;
 * an operator note is not a revocation. Merchant webhooks are the merchant's
 * own systems and are reversed at the merchant's cost.
 */
function externalBlocker(order: CaseOrder): string | null {
  const faka = order.fakaBridgeTask
  if (faka && faka.status !== 'cancelled' && faka.status !== 'failed') {
    if (faka.status !== 'succeeded') return '外部开通状态尚未确认，请先在开通任务中核对'
    if (faka.revokeStatus !== 'succeeded') return '外部权益尚未撤销，请先完成开通任务撤销'
  }
  const job = order.fulfillmentJob
  if (job && job.status !== 'cancelled' && job.status !== 'failed') {
    return '外部履约已执行且无可验证撤销记录，不能售后退款'
  }
  return null
}

async function merchantSettlementAvailable(db: Db, merchantUserId: number) {
  const result = await db.pointLot.aggregate({
    where: { userId: merchantUserId, originKind: 'merchant_settlement', availablePoints: { gt: 0 } },
    _sum: { availablePoints: true },
  })
  return result._sum.availablePoints ?? 0
}

export async function serializeAfterSalesCase(db: Db, caseId: number) {
  const row = await db.orderAfterSalesCase.findUnique({
    where: { id: caseId },
    include: {
      order: { select: orderSelect },
      adjustment: { include: { recoveryCase: { select: { id: true, amountDue: true, status: true } } } },
    },
  })
  if (!row) throw notFound('售后案件不存在')
  const order = row.order
  const settlement = order.settlement
  const blocker = order.status === 'closed' ? externalBlocker(order) : '订单不是已关闭状态'
  const settledNet = settlement?.status === 'settled' ? settlement.settlementAmount : 0
  const available = settledNet > 0 && order.merchant ? await merchantSettlementAvailable(db, order.merchant.userId) : 0
  return {
    id: row.id,
    caseNo: row.caseNo,
    orderId: row.orderId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    evidence: row.evidence,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    refundOperationId: row.refundOperationId,
    refundAmount: order.price,
    paymentComposition: await orderPaymentComposition(db, order.id),
    settlement: settlement
      ? {
        id: settlement.id,
        status: settlement.status,
        settlementAmount: settlement.settlementAmount,
        commissionAmount: settlement.commissionAmount,
        batchId: settlement.batchItem?.batchId ?? null,
      }
      : null,
    // Preview only; execute recomputes under locks.
    estimatedShortfall: row.status === 'open' ? Math.max(0, settledNet - available) : null,
    adjustment: row.adjustment
      ? {
        id: row.adjustment.id,
        settlementDelta: row.adjustment.settlementDelta,
        commissionDelta: row.adjustment.commissionDelta,
        clawbackPoints: row.adjustment.clawbackPoints,
        recoveryCase: row.adjustment.recoveryCase,
      }
      : null,
    blocker: row.status === 'open' ? blocker : null,
    allowedActions: row.status === 'open' ? (blocker ? ['reject'] : ['execute', 'reject']) : [],
  }
}

export async function listOrderAfterSalesCases(orderId: number) {
  const rows = await prisma.orderAfterSalesCase.findMany({ where: { orderId }, select: { id: true }, orderBy: { id: 'desc' } })
  return Promise.all(rows.map(row => serializeAfterSalesCase(prisma, row.id)))
}

export async function createAfterSalesCase(adminUserId: number, orderId: number, input: { reason: string; evidence?: string }) {
  return prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } })
  if (!order) throw notFound('订单不存在')
  if (order.status !== 'closed') throw badRequest('只有已关闭订单可发起售后；未完成订单请走取消或仲裁')
  try {
    const created = await tx.orderAfterSalesCase.create({
      data: { orderId, reason: input.reason, evidence: input.evidence ?? null, createdByUserId: adminUserId },
    })
    await tx.adminLog.create({
      data: { adminUserId, action: '发起订单售后', targetType: 'order', targetId: orderId, detail: `案件 #${created.id}: ${input.reason}` },
    })
    return serializeAfterSalesCase(tx, created.id)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict('该订单已有进行中或已执行的全额售后')
    }
    throw error
  }
  })
}

export async function rejectAfterSalesCase(adminUserId: number, caseId: number, note: string) {
  return prisma.$transaction(async tx => {
    const updated = await tx.orderAfterSalesCase.updateMany({
      where: { id: caseId, status: 'open' },
      data: { status: 'rejected', decidedByUserId: adminUserId, decidedAt: new Date(), decisionNote: note },
    })
    if (updated.count !== 1) throw conflict('售后案件状态已变化，请刷新后重试')
    const row = await tx.orderAfterSalesCase.findUniqueOrThrow({ where: { id: caseId }, select: { orderId: true } })
    await tx.adminLog.create({
      data: { adminUserId, action: '驳回订单售后', targetType: 'order', targetId: row.orderId, detail: `案件 #${caseId}: ${note}` },
    })
    return serializeAfterSalesCase(tx, caseId)
  })
}

/**
 * One transaction: buyer refund to original sources, earning void/reversal,
 * merchant clawback and shortfall. Lock order: Order -> case -> Settlement ->
 * Merchant -> buyer and merchant accounts (sorted) -> lots.
 */
export async function executeAfterSalesCase(adminUserId: number, caseId: number, note?: string) {
  return prisma.$transaction(async tx => {
    const target = await tx.orderAfterSalesCase.findUnique({ where: { id: caseId }, select: { orderId: true } })
    if (!target) throw notFound('售后案件不存在')
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${target.orderId} FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "OrderAfterSalesCase" WHERE "id" = ${caseId} FOR UPDATE`
    const afterSales = await tx.orderAfterSalesCase.findUniqueOrThrow({ where: { id: caseId } })
    if (afterSales.status !== 'open') throw conflict('售后案件已处理')

    const order = await tx.order.findUniqueOrThrow({ where: { id: target.orderId }, select: orderSelect })
    if (order.status !== 'closed') throw conflict('订单不是已关闭状态')
    const blocker = externalBlocker(order)
    if (blocker) throw conflict(blocker)

    if (order.settlement) {
      await tx.$queryRaw`SELECT "id" FROM "Settlement" WHERE "id" = ${order.settlement.id} FOR UPDATE`
    }
    if (order.merchantId != null) {
      await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${order.merchantId} FOR UPDATE`
    }
    await lockAccountsInTx(tx, [order.userId, ...(order.merchant ? [order.merchant.userId] : [])])

    const refund = await refundPaidOrder(tx, order, `售后退款: #${order.id}`, adminUserId)

    let reversal: Awaited<ReturnType<typeof reverseForAfterSalesInTx>> | null = null
    const settlement = order.settlement
      ? await tx.settlement.findUniqueOrThrow({ where: { id: order.settlement.id }, select: { id: true, status: true } })
      : null
    if (settlement?.status === 'settled') {
      reversal = await reverseForAfterSalesInTx(tx, {
        settlementId: settlement.id,
        afterSalesCaseId: caseId,
        actorUserId: adminUserId,
        reason: afterSales.reason,
      })
    } else if (settlement) {
      await voidUnsettledInTx(tx, order.id, ['pending', 'holding'])
    }

    await tx.orderAfterSalesCase.update({
      where: { id: caseId },
      data: {
        status: 'executed',
        refundOperationId: refund.operationId,
        decidedByUserId: adminUserId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    })
    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId: adminUserId,
      actorRole: 'admin',
      fromStatus: order.status,
      toStatus: order.status,
      action: 'admin.after_sales.refund',
      publicNote: '平台售后：积分已按原支付来源退还',
      internalNote: note,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '执行订单售后退款',
        targetType: 'order',
        targetId: order.id,
        detail: reversal
          ? `案件 #${caseId}，退款 ${refund.amount}，扣回 ${reversal.clawbackPoints}，欠收 ${reversal.shortfall}`
          : `案件 #${caseId}，退款 ${refund.amount}`,
      },
    })
    return serializeAfterSalesCase(tx, caseId)
  })
}
