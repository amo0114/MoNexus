import type { Prisma } from '@prisma/client'
import type { CancellationAssessment } from '../../extension-contracts/fulfillment.js'
import { afterCancellationAssessed, assessProviderCancellationsInTx } from '../fulfillment/coordination.js'

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
