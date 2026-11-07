import type { FulfillmentProvider } from '../../extension-contracts/fulfillment.js'
import { prisma } from '../../lib/prisma.js'
import { invalidateGrantForOrderInTx } from '../trafficReset/benefits.js'
import { startResetCron, stopResetCron } from '../trafficReset/worker.js'
import { startAccountBackfillCron, stopAccountBackfillCron } from '../xboardAccounts/cron.js'
import { onFakaOrderRefundedInTx, scheduleFakaRevokeAttempt } from './lifecycle.js'
import { startFakaBridgeCron, stopFakaBridgeCron } from './worker.js'

/** Built-in Xboard provider: FakaBridge provisioning plus its free-reset benefit. */
export const xboardFulfillmentProvider: FulfillmentProvider = {
  id: 'faka_bridge',
  onOrderRefundedInTx: onFakaOrderRefundedInTx,
  async afterOrderRefunded(orderId) {
    const task = await prisma.fakaBridgeTask.findUnique({
      where: { orderId },
      select: { id: true, revokeStatus: true },
    })
    if (task?.revokeStatus === 'pending') scheduleFakaRevokeAttempt(task.id)
  },
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
    stopFakaBridgeCron()
    await Promise.all([stopResetCron(), stopAccountBackfillCron()])
  },
}
