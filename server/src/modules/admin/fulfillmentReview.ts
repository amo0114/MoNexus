import { prisma } from '../../lib/prisma.js'
import { conflict, notFound } from '../../lib/httpError.js'
import { assessAndBlockCancellationInTx, afterOrderCancellationAssessed } from '../orders/cancellation.js'
import { afterOrderRefunded, onOrderRefundedInTx } from '../fulfillment/coordination.js'
import { refundUndeliveredExternalOrderInTx } from '../fulfillment/apply.js'

/** Human reconciliation requires recorded remote evidence, never age/404 alone. */
export async function reviewOrderFulfillment(adminUserId: number, orderId: number,
  input: { action: 'retry' | 'confirm_cancelled'; evidence?: string }) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.order.findUnique({ where: { id: orderId }, include: {
      delivery: { select: { id: true } }, fulfillmentJob: true, fakaBridgeTask: true, provisionTask: true,
    } })
    if (!order) throw notFound('订单不存在')
    if (!['pending', 'processing'].includes(order.status) || order.delivery) throw conflict('仅未交付且未结束的订单可核对取消')
    let refunded = false
    if (input.action === 'retry') {
      const verdict = await assessAndBlockCancellationInTx(tx, orderId)
      if (verdict === 'already_executed') throw conflict('已有开通证据，请核实交付或在远端撤销后处理')
      await tx.order.update({ where: { id: orderId }, data: { cancelRequestedAt: order.cancelRequestedAt ?? new Date() } })
      if (verdict === 'safe_to_finalize') {
        await refundUndeliveredExternalOrderInTx(tx, order, { action: 'admin.fulfillment.safe_cancel',
          publicNote: '平台核对后取消订单，积分已退还', releaseReason: `平台核对取消退款: #${orderId}` })
        refunded = true
      }
    } else {
      if (!order.cancelRequestedAt) throw conflict('请先请求核对取消，再确认远端撤销证据')
      // Xboard requires a verified revoke tombstone; human notes cannot replace it.
      if (order.fakaBridgeTask) throw conflict('Xboard 订单须通过供应商撤销核验，请重新核对取消或处理撤销任务')
      if (order.provisionTask) {
        const locked = await tx.$queryRaw<Array<{ id: number }>>`SELECT "id" FROM "ProvisionTask" WHERE "id" = ${order.provisionTask.id} FOR UPDATE SKIP LOCKED`
        if (!locked.length) throw conflict('任务正在认领，请稍后重新核对')
      }
      const tasks = [order.fulfillmentJob, order.fakaBridgeTask, order.provisionTask].filter(Boolean)
      if (tasks.some(task => task!.leaseUntil && task!.leaseUntil > new Date())) throw conflict('任务仍在执行，请等待租约结束后核对')
      if (order.fulfillmentJob?.status === 'succeeded' || order.provisionTask?.status === 'succeeded') {
        throw conflict('已有开通成功证据，请先在远端撤销并核对')
      }
      if (!input.evidence || input.evidence.trim().length < 20) throw conflict('请记录远端已撤销或未生效的核对证据，至少 20 字符')
      // The operator has verified remote absence. Retain the evidence in the
      // audit/event, and stop automatic claims without inventing provider RPC results.
      if (order.fulfillmentJob) await tx.fulfillmentJob.update({ where: { id: order.fulfillmentJob.id }, data: {
        status: 'cancelled', cancelRequested: true, leaseToken: null, leaseUntil: null, completedAt: new Date(), note: 'operator confirmed remote cancellation',
      } })
      if (order.provisionTask) await tx.provisionTask.update({ where: { id: order.provisionTask.id }, data: { status: 'cancelled', leaseUntil: null } })
      await refundUndeliveredExternalOrderInTx(tx, order, { action: 'admin.fulfillment.confirm_cancelled',
        publicNote: '平台已核对远端取消，积分已退还', internalNote: input.evidence,
        releaseReason: `平台确认远端撤销退款: #${orderId}` })
      refunded = true
    }
    if (refunded) await onOrderRefundedInTx(tx, orderId)
    await tx.adminLog.create({ data: { adminUserId, action: `fulfillment.${input.action}`, targetType: 'order', targetId: orderId,
      detail: input.evidence ?? '重新核对取消；未知结果保持冻结积分' } })
    return { orderId, outcome: refunded ? 'refunded' : 'cancel_pending' }
  }, { timeout: 15_000, maxWait: 5_000 })
  if (result.outcome === 'refunded') await afterOrderRefunded(orderId)
  else await afterOrderCancellationAssessed(orderId)
  return result
}
