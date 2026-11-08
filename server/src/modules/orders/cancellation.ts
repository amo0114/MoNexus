import type { Prisma } from '@prisma/client'
import type { CancellationAssessment } from '../../extension-contracts/fulfillment.js'
import { conflict, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { afterCancellationAssessed, afterOrderRefunded, assessProviderCancellationsInTx, onOrderRefundedInTx } from '../fulfillment/coordination.js'
import { releaseHeldOrder } from './accounting.js'
import { transitionOrderStatus } from './fulfillment.js'
import { applyRefundInventoryPolicy } from './refundInventory.js'

type Tx = Prisma.TransactionClient

export type { CancellationAssessment }

// Most conservative verdict wins when several executors own work for one order.
const SEVERITY: CancellationAssessment[] = ['safe_to_finalize', 'reconcile_required', 'unsupported', 'already_executed']

/**
 * Local cancellation barrier for an unfinished order. The caller must hold the
 * Order row lock (`SELECT … FOR UPDATE`) and decide the refund itself: this
 * only revokes dispatch rights or records the cancel intent, never moves
 * points, and never calls the network. Run `afterOrderCancellationAssessed`
 * after commit to kick any queued query/cancel.
 */
export async function assessAndBlockCancellationInTx(tx: Tx, orderId: number): Promise<CancellationAssessment> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      deliveryModeSnapshot: true,
      fulfillmentJob: { select: { providerId: true } },
      fakaBridgeTask: { select: { id: true } },
    },
  })
  const { verdicts, assessedProviderIds } = await assessProviderCancellationsInTx(tx, orderId)
  const webhook = await assessProvisionTaskInTx(tx, orderId)
  if (webhook) verdicts.push(webhook)

  // A task whose owner could not answer (unregistered provider, no hook) is never "nothing happened".
  const unassessedJob = order.fulfillmentJob && !assessedProviderIds.includes(order.fulfillmentJob.providerId)
  const unassessedFaka = order.fakaBridgeTask && !assessedProviderIds.includes('faka_bridge')
  if (unassessedJob || unassessedFaka) verdicts.push('unsupported')

  if (verdicts.length > 0) {
    return verdicts.reduce((worst, verdict) => (SEVERITY.indexOf(verdict) > SEVERITY.indexOf(worst) ? verdict : worst))
  }
  // No executor ever owned work: a manual order is local-only. Other modes
  // deliver at checkout, so an unfinished one without a task is unexplained.
  return order.deliveryModeSnapshot === 'manual_service' ? 'safe_to_finalize' : 'unsupported'
}

export async function afterOrderCancellationAssessed(orderId: number): Promise<void> {
  await afterCancellationAssessed(orderId)
}

/**
 * Merchant webhook auto-provisioning has no status/cancel protocol, so any
 * possible dispatch is `unsupported`. Its claim locks the task before the
 * Order (the reverse of our order), hence SKIP LOCKED: a row being claimed
 * right now is treated as possibly dispatched instead of risking a deadlock.
 */
async function assessProvisionTaskInTx(tx: Tx, orderId: number): Promise<CancellationAssessment | null> {
  const exists = await tx.provisionTask.findUnique({ where: { orderId }, select: { id: true } })
  if (!exists) return null
  const rows = await tx.$queryRaw<Array<{ id: number; status: string; attempts: number }>>`
    SELECT "id", "status", "attempts" FROM "ProvisionTask" WHERE "id" = ${exists.id} FOR UPDATE SKIP LOCKED`
  const task = rows[0]
  if (!task) return 'unsupported'
  if (task.status === 'succeeded') return 'already_executed'
  if (task.attempts === 0) {
    if (task.status === 'pending') {
      await tx.provisionTask.update({ where: { id: task.id }, data: { status: 'cancelled', leaseUntil: null } })
    }
    return 'safe_to_finalize'
  }
  // Possibly delivered remotely: stop further retries; a late result fails the pending CAS and is discarded.
  if (task.status === 'pending') {
    await tx.provisionTask.update({
      where: { id: task.id },
      data: { status: 'cancelled', leaseUntil: null, lastError: 'order_cancel_requested' },
    })
  }
  return 'unsupported'
}

export type UnacceptedCancelActor = { kind: 'buyer'; userId: number } | { kind: 'timeout' }

/** `cancelled`: points released now. `cancel_pending`: remote work must converge first (HTTP 202). */
export type UnacceptedCancelOutcome = 'cancelled' | 'cancel_pending'

const CANCEL_COPY = {
  buyer: { reason: 'buyer_cancelled', action: 'user.order.cancel', note: '买家取消订单，积分已退还', release: '买家取消释放冻结积分' },
  timeout: { reason: 'accept_timeout', action: 'system.order.accept_timeout', note: '商家超时未接单，订单已自动取消，积分已退还', release: '接单超时释放冻结积分' },
} as const

/**
 * Cancel an order nobody has accepted yet: by its buyer, or by the system once
 * `acceptBy` passed. Both race the merchant's accept on the same Order lock,
 * so exactly one wins. Only orders with an accept deadline (new plain manual
 * orders) qualify; legacy pending orders are handled separately.
 */
export async function cancelUnacceptedOrder(orderId: number, actor: UnacceptedCancelActor): Promise<UnacceptedCancelOutcome> {
  const copy = CANCEL_COPY[actor.kind]
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, userId: true, status: true, acceptBy: true, cancelRequestedAt: true, resolutionReason: true,
        holdingPoints: true, fundsHeld: true, productId: true, offerId: true, merchantId: true, deliveryModeSnapshot: true,
      },
    })
    if (!order || (actor.kind === 'buyer' && order.userId !== actor.userId)) throw notFound('订单不存在')
    // Replays of a finished cancel return the same outcome instead of an error.
    if (order.status === 'refunded' && order.resolutionReason === copy.reason) return 'cancelled'
    if (order.status !== 'pending') throw conflict('订单已被接单或已结束，不能取消')
    if (!order.acceptBy) throw conflict('该订单不支持直接取消，请联系商家或平台处理')
    if (actor.kind === 'timeout' && order.acceptBy > new Date()) throw conflict('接单期限未到')
    if (order.cancelRequestedAt) return 'cancel_pending'

    const verdict = await assessAndBlockCancellationInTx(tx, order.id)
    if (verdict === 'reconcile_required') {
      await tx.order.update({ where: { id: order.id }, data: { cancelRequestedAt: new Date() } })
      return 'cancel_pending'
    }
    if (verdict !== 'safe_to_finalize') throw conflict('订单可能已在处理，不能直接取消，请联系商家或平台处理')

    await transitionOrderStatus({
      orderId: order.id,
      toStatus: 'refunded',
      actorRole: actor.kind === 'buyer' ? 'user' : 'system',
      actorUserId: actor.kind === 'buyer' ? actor.userId : null,
      action: copy.action,
      publicNote: copy.note,
    }, tx)
    await releaseHeldOrder(tx, order, `${copy.release}: #${order.id}`)
    await applyRefundInventoryPolicy(tx, order, { fromStatus: 'pending', actorUserId: order.userId })
    await onOrderRefundedInTx(tx, order.id)
    await tx.order.update({ where: { id: order.id }, data: { resolutionReason: copy.reason } })
    return 'cancelled'
  })
  if (result === 'cancelled') await afterOrderRefunded(orderId)
  else await afterOrderCancellationAssessed(orderId)
  return result
}
