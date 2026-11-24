import { getCachedFakaCapacityByPlanId, getFakaCapacityForPublicRead } from '../../lib/fakaBridge/capacity.js'
import { isFakaBridgeConfigured } from '../../lib/fakaBridge/client.js'
import { normalizeFakaOfferIntegration } from '../../lib/fakaBridge/offerIntegration.js'
import { usesStablePaidReset } from '../../lib/fakaBridge/paidResetSku.js'
import type { FulfillmentProvider } from '../../extension-contracts/fulfillment.js'
import { prisma } from '../../lib/prisma.js'
import { invalidateGrantForOrderInTx } from '../trafficReset/benefits.js'
import { startResetCron, stopResetCron } from '../trafficReset/worker.js'
import { startAccountBackfillCron, stopAccountBackfillCron } from '../xboardAccounts/cron.js'
import { xboardCheckout } from './checkout.js'
import { assessFakaCancellationInTx, onFakaOrderRefundedInTx, scheduleFakaRevokeAttempt } from './lifecycle.js'
import { startFakaBridgeCron, stopFakaBridgeCron } from './worker.js'

async function kickPendingRevoke(orderId: number): Promise<void> {
  const task = await prisma.fakaBridgeTask.findUnique({
    where: { orderId },
    select: { id: true, revokeStatus: true },
  })
  if (task?.revokeStatus === 'pending') scheduleFakaRevokeAttempt(task.id)
}

/** Built-in Xboard provider: FakaBridge provisioning plus its free-reset benefit. */
export const xboardFulfillmentProvider: FulfillmentProvider = {
  id: 'faka_bridge',
  label: 'Xboard（FakaBridge）',
  checkout: xboardCheckout,
  catalog: {
    isConfigured: isFakaBridgeConfigured,
    normalizeBinding: normalizeFakaOfferIntegration,
    usesAccountCapacity: usesStablePaidReset,
    capacityForPublicRead: getFakaCapacityForPublicRead,
    cachedCapacityByPlanId: getCachedFakaCapacityByPlanId,
  },
  async isProvisionPending(orderId) {
    const task = await prisma.fakaBridgeTask.findUnique({ where: { orderId }, select: { status: true } })
    return task?.status === 'pending'
  },
  onOrderRefundedInTx: onFakaOrderRefundedInTx,
  afterOrderRefunded: kickPendingRevoke,
  orderDiagnostics(tx, orderId) {
    return tx.fakaBridgeTask.findUnique({ where: { orderId }, select: {
      id: true, status: true, attempts: true, cancelRequested: true,
      revokeStatus: true, revokedAt: true, leaseUntil: true,
    } })
  },
  operatorReviewWhere: { fakaBridgeTask: { OR: [{ status: 'needs_reconcile' }, { revokeStatus: 'failed' }] } },
  orderBacklog: [{ state: 'faka_revoke_failed', where: { fakaBridgeTask: { revokeStatus: 'failed' } } }],
  countOpenOfferTasks(tx, offerIds) {
    return tx.fakaBridgeTask.count({
      where: {
        order: { offerId: { in: offerIds } },
        OR: [{ status: { in: ['pending', 'needs_reconcile'] } }, { revokeStatus: 'pending' }],
      },
    })
  },
  async closedOrderRefundBlocker(tx, orderId) {
    const task = await tx.fakaBridgeTask.findUnique({
      where: { orderId },
      select: { status: true, revokeStatus: true },
    })
    if (!task) return '外部开通任务记录缺失，请先核对'
    if (task.status === 'cancelled' || task.status === 'failed') return null
    if (task.status !== 'succeeded') return '外部开通状态尚未确认，请先在开通任务中核对'
    return task.revokeStatus === 'succeeded' ? null : '外部权益尚未撤销，请先完成开通任务撤销'
  },
  assessCancellationInTx: assessFakaCancellationInTx,
  afterCancellationAssessed: kickPendingRevoke,
  async onOrderStatusChangedInTx(tx, orderId, toStatus) {
    // The welcome reset grant stays tied to an undisputed delivered purchase.
    if (['refunded', 'disputed', 'processing'].includes(toStatus)) await invalidateGrantForOrderInTx(tx, orderId)
  },
  startBackgroundJobs() {
    startFakaBridgeCron()
    startResetCron()
    startAccountBackfillCron()
  },
  async stopBackgroundJobs() {
    await Promise.all([stopFakaBridgeCron(), stopResetCron(), stopAccountBackfillCron()])
  },
}
