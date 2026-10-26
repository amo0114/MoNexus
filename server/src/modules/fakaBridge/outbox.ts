import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { buildFakaExternalOrderNo } from '../../lib/fakaBridge/client.js'
import { periodFromFakaSku } from '../../lib/fakaBridge/skuPeriod.js'
import { processFakaBridgeTask } from './worker.js'
import { accountSettings } from '../xboardAccounts/settings.js'

type Tx = Prisma.TransactionClient

export interface CreateFakaBridgeTaskInput {
  orderId: number
  email: string
  sku: string
  /** Optional; derived from SKU when omitted (named + plan-* aliases). */
  period?: string
  maxAttempts?: number
  /** Set only after website checkout has verified a stable owned account. */
  paidReset?: { accountLinkId: string }
}

/**
 * Transactional outbox row for Xboard FakaBridge provision.
 * Must be created in the same DB transaction as the Order.
 */
export async function createFakaBridgeTaskForOrder(tx: Tx, input: CreateFakaBridgeTaskInput) {
  const email = input.email.toLowerCase().trim()
  const sku = input.sku.trim().toLowerCase()
  const period = (input.period ?? periodFromFakaSku(sku, 'monthly')).trim().toLowerCase()
  const maxAttempts = input.maxAttempts ?? config.fakaBridge.maxAttempts

  let target = {}
  let emailSnapshot = email
  if (input.paidReset) {
    const settings = accountSettings()
    const [link, order, instance] = await Promise.all([
      tx.xboardAccountLink.findUnique({ where: { id: input.paidReset.accountLinkId } }),
      tx.order.findUnique({ where: { id: input.orderId }, select: { userId: true, user: { select: { status: true } } } }),
      tx.xboardInstance.findUnique({ where: { id: settings.instanceId } }),
    ])
    const match = /^plan-([1-9][0-9]{0,9})-(?:reset_traffic|reset_price)$/.exec(sku)
    if (!link || !order || order.user.status !== '正常' || link.userId !== order.userId || link.status !== 'active'
      || link.instanceId !== settings.instanceId || instance?.origin !== settings.origin || period !== 'reset_traffic'
      || !match || BigInt(match[1]) > 2147483647n) throw new Error('Invalid stable paid reset target')
    target = { protocolVersion: 2, accountLinkIdSnapshot: link.id, instanceIdSnapshot: settings.instanceId,
      originSnapshot: settings.origin, xboardUserIdSnapshot: link.xboardUserId, expectedPlanIdSnapshot: match[1],
      clientIdSnapshot: config.trafficReset.clientId }
    emailSnapshot = link.currentEmail
  }

  return tx.fakaBridgeTask.create({
    data: {
      orderId: input.orderId,
      requestOrderNo: buildFakaExternalOrderNo(input.orderId),
      emailSnapshot,
      skuSnapshot: sku,
      periodSnapshot: period,
      maxAttempts,
      status: 'pending',
      nextAttemptAt: new Date(),
      ...target,
    },
  })
}

/**
 * Post-commit first attempt: fire-and-forget real worker (M4).
 * Never blocks the purchase HTTP response.
 */
export function scheduleFakaBridgeFirstAttempt(taskId: number): void {
  if (config.nodeEnv === 'test') {
    return
  }
  setImmediate(() => {
    void processFakaBridgeTask(taskId).catch(err => {
      logger.error({ err, taskId, component: 'fakaBridge' }, 'FakaBridge first attempt failed')
    })
  })
}
