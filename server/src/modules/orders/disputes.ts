import type { Prisma } from '@prisma/client'
import { badRequest, conflict, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { afterOrderRefunded, onOrderRefundedInTx } from '../fulfillment/coordination.js'
import { releaseHeldOrder } from './accounting.js'
import { assessAndBlockCancellationInTx } from './cancellation.js'
import { DISPUTE_RESPONSE_MS, transitionOrderStatus } from './fulfillment.js'
import { applyRefundInventoryPolicy } from './refundInventory.js'
import { isInstantMode, normalizeOrderStatus } from './statusPolicy.js'

type Tx = Prisma.TransactionClient

const DISPUTED_ORDER_SELECT = {
  id: true, userId: true, merchantId: true, status: true, deliveryModeSnapshot: true,
  holdingPoints: true, fundsHeld: true, productId: true, offerId: true,
  fulfillmentDeadline: true, disputeRespondBy: true, remedyNote: true, remedyProposedAt: true,
  remedyRespondBy: true, disputeEscalatedAt: true,
  delivery: { select: { id: true } },
  fakaBridgeTask: { select: { id: true } },
  fulfillmentJob: { select: { id: true } },
} satisfies Prisma.OrderSelect

async function lockOrder(tx: Tx, orderId: number) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
  return tx.order.findUnique({ where: { id: orderId }, select: DISPUTED_ORDER_SELECT })
}

/**
 * Buyer complaint once the fulfilment deadline passed without a delivery. The
 * order becomes disputed and the seller gets the standard response window;
 * automatic executors are excluded because their remote state decides.
 */
export async function fileOverdueComplaint(orderId: number, userId: number): Promise<void> {
  await prisma.$transaction(async tx => {
    const order = await lockOrder(tx, orderId)
    if (!order || order.userId !== userId) throw notFound('订单不存在')
    if (normalizeOrderStatus(order.status) !== 'processing') throw conflict('只有履约中的订单可以投诉超时')
    if (order.deliveryModeSnapshot !== 'manual_service') throw conflict('只有人工服务订单可以投诉超时')
    if (order.fakaBridgeTask || order.fulfillmentJob) throw conflict('自动开通订单请联系平台处理')
    if (!order.fulfillmentDeadline || order.fulfillmentDeadline > new Date()) throw conflict('尚未超过履约期限')
    await transitionOrderStatus({
      orderId,
      toStatus: 'disputed',
      actorRole: 'user',
      actorUserId: userId,
      action: 'user.dispute.overdue',
      publicNote: '买家投诉：超过履约期限仍未交付',
      overdueComplaint: true,
    }, tx)
  })
}

/** Seller proposes how to fix the dispute; the order stays disputed until the buyer accepts. */
export async function proposeRemedyInTx(
  tx: Tx,
  orderId: number,
  actor: { role: 'merchant' | 'admin'; userId: number },
  note: string,
): Promise<void> {
  const order = await lockOrder(tx, orderId)
  if (!order) throw notFound('订单不存在')
  if (normalizeOrderStatus(order.status) !== 'disputed') throw conflict('订单不在争议中，不能处理争议')
  if (order.disputeEscalatedAt) throw conflict('争议已提交平台裁决，请等待处理结果')
  if (order.remedyProposedAt) throw conflict('补救方案已提交，正在等待买家确认')
  if (!note.trim()) throw badRequest('请填写补救方案说明')
  const now = new Date()
  await tx.order.update({
    where: { id: orderId },
    data: {
      remedyNote: note.trim(),
      remedyProposedAt: now,
      remedyRespondBy: new Date(now.getTime() + DISPUTE_RESPONSE_MS),
      disputeRespondBy: null,
    },
  })
  await tx.orderStatusEvent.create({
    data: {
      orderId, actorUserId: actor.userId, actorRole: actor.role, fromStatus: 'disputed', toStatus: 'disputed',
      action: `${actor.role}.dispute.remedy`, publicNote: `补救方案：${note.trim()}`,
    },
  })
}

/**
 * Accepting a remedy (by the buyer, or by letting the window lapse) ends the
 * dispute the way the old merchant resume did: a manual order goes back to
 * processing with a fresh deadline, an instant order back to delivered.
 */
async function acceptRemedyInTx(tx: Tx, order: { id: number; deliveryModeSnapshot: string | null }, actor: { kind: 'buyer'; userId: number } | { kind: 'lapse' }) {
  const manual = !isInstantMode(order.deliveryModeSnapshot ?? '')
  await transitionOrderStatus({
    orderId: order.id,
    toStatus: manual ? 'processing' : 'delivered',
    actorRole: actor.kind === 'buyer' ? 'user' : 'system',
    actorUserId: actor.kind === 'buyer' ? actor.userId : null,
    action: actor.kind === 'buyer' ? 'user.dispute.accept_remedy' : 'system.dispute.remedy_lapsed',
    publicNote: actor.kind === 'buyer' ? '买家接受补救方案，争议结束' : '买家逾期未回应，视为接受补救方案',
    resumeDispute: true,
  }, tx)
  if (manual) {
    const slaDays = await getSystemConfigValue('fulfillmentSlaDays', tx)
    await tx.order.update({
      where: { id: order.id },
      data: { fulfillmentDeadline: new Date(Date.now() + slaDays * 24 * 60 * 60 * 1000) },
    })
  }
}

export async function answerRemedy(orderId: number, userId: number, accept: boolean): Promise<void> {
  await prisma.$transaction(async tx => {
    const order = await lockOrder(tx, orderId)
    if (!order || order.userId !== userId) throw notFound('订单不存在')
    if (normalizeOrderStatus(order.status) !== 'disputed' || !order.remedyProposedAt) throw conflict('当前没有待确认的补救方案')
    if (accept) {
      await acceptRemedyInTx(tx, order, { kind: 'buyer', userId })
      return
    }
    await tx.order.update({
      where: { id: orderId },
      data: { disputeEscalatedAt: new Date(), remedyRespondBy: null },
    })
    await tx.orderStatusEvent.create({
      data: {
        orderId, actorUserId: userId, actorRole: 'user', fromStatus: 'disputed', toStatus: 'disputed',
        action: 'user.dispute.reject_remedy', publicNote: '买家拒绝补救方案，已提交平台裁决',
      },
    })
  })
}

export type DisputeTimerOutcome = 'remedy_accepted' | 'refunded' | 'escalated' | 'skipped'

/** Apply one due timer under the Order lock; re-checks everything the candidate query saw. */
export async function applyDueDisputeTimer(orderId: number, now = new Date()): Promise<DisputeTimerOutcome> {
  const outcome = await prisma.$transaction(async tx => {
    const order = await lockOrder(tx, orderId)
    if (!order || normalizeOrderStatus(order.status) !== 'disputed' || order.disputeEscalatedAt) return 'skipped'
    if (order.remedyProposedAt && order.remedyRespondBy && order.remedyRespondBy <= now) {
      await acceptRemedyInTx(tx, order, { kind: 'lapse' })
      return 'remedy_accepted'
    }
    if (order.remedyProposedAt || !order.disputeRespondBy || order.disputeRespondBy > now) return 'skipped'
    // Seller never answered. Nothing delivered → the buyer gets the refund, unless an
    // executor may have run remotely; after a delivery the platform must judge.
    if (!order.delivery && await assessAndBlockCancellationInTx(tx, order.id) === 'safe_to_finalize') {
      await transitionOrderStatus({
        orderId: order.id,
        toStatus: 'refunded',
        actorRole: 'system',
        action: 'system.dispute.no_response_refund',
        publicNote: '商家逾期未回应投诉，订单已取消，积分已退还',
      }, tx)
      await releaseHeldOrder(tx, order, `商家逾期未回应释放冻结积分: #${order.id}`)
      await applyRefundInventoryPolicy(tx, order, { fromStatus: 'processing', actorUserId: order.userId })
      await onOrderRefundedInTx(tx, order.id)
      await tx.order.update({ where: { id: order.id }, data: { resolutionReason: 'merchant_no_response' } })
      return 'refunded'
    }
    await tx.order.update({ where: { id: order.id }, data: { disputeEscalatedAt: now, disputeRespondBy: null } })
    await tx.orderStatusEvent.create({
      data: {
        orderId: order.id, actorRole: 'system', fromStatus: 'disputed', toStatus: 'disputed',
        action: 'system.dispute.escalated', publicNote: '商家逾期未回应，已提交平台裁决',
      },
    })
    return 'escalated'
  })
  if (outcome === 'refunded') await afterOrderRefunded(orderId)
  return outcome
}
