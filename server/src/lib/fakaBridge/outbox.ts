import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { logger } from '../logger.js'
import { buildFakaExternalOrderNo } from './client.js'
import { periodFromFakaSku } from './skuPeriod.js'
import { processFakaBridgeTask } from './worker.js'

type Tx = Prisma.TransactionClient

export interface CreateFakaBridgeTaskInput {
  orderId: number
  email: string
  sku: string
  /** Optional; derived from SKU when omitted (named + plan-* aliases). */
  period?: string
  maxAttempts?: number
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

  return tx.fakaBridgeTask.create({
    data: {
      orderId: input.orderId,
      requestOrderNo: buildFakaExternalOrderNo(input.orderId),
      emailSnapshot: email,
      skuSnapshot: sku,
      periodSnapshot: period,
      maxAttempts,
      status: 'pending',
      nextAttemptAt: new Date(),
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
