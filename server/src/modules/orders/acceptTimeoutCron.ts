import { config } from '../../config/index.js'
import { HttpError } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { cancelUnacceptedOrder } from './cancellation.js'

// The deadline is enforced at accept time already; the scan only has to free
// buyers' points within minutes, not exactly at the deadline.
const ACCEPT_TIMEOUT_INTERVAL_MS = 5 * 60 * 1000
const BATCH_SIZE = 50

let timer: NodeJS.Timeout | null = null
let running = false

async function runAcceptTimeoutBatch(now = new Date()): Promise<number> {
  if (running) return 0
  running = true
  let lease: CronLeaseHandle | null = null
  let cancelled = 0
  try {
    lease = await acquireCronLeaseWithHeartbeat('orderAcceptTimeout', ACCEPT_TIMEOUT_INTERVAL_MS)
    if (!lease) return 0
    const candidates = await prisma.order.findMany({
      where: { status: 'pending', acceptBy: { lte: now }, cancelRequestedAt: null },
      orderBy: [{ acceptBy: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true },
    })
    for (const { id } of candidates) {
      try {
        // Same command as the buyer's cancel; it re-checks status and deadline under the Order lock.
        if (await cancelUnacceptedOrder(id, { kind: 'timeout' }) === 'cancelled') cancelled += 1
      } catch (err) {
        // Accepted or finished meanwhile is expected; anything else must not block the batch.
        if (err instanceof HttpError && err.status === 409) continue
        logger.warn({ err, orderId: id }, 'accept-timeout cancel failed for order')
      }
    }
    if (cancelled > 0) logger.info({ count: cancelled }, 'unaccepted orders cancelled after accept timeout')
  } catch (err) {
    logger.error({ err }, 'accept-timeout cron batch failed')
  } finally {
    lease?.release()
    running = false
  }
  return cancelled
}

export function startAcceptTimeoutCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  void runAcceptTimeoutBatch()
  timer = setInterval(() => { void runAcceptTimeoutBatch() }, ACCEPT_TIMEOUT_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: ACCEPT_TIMEOUT_INTERVAL_MS }, 'order accept-timeout cron started')
}

export function stopAcceptTimeoutCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export async function __runAcceptTimeoutBatchForTests(now?: Date) {
  return runAcceptTimeoutBatch(now)
}
