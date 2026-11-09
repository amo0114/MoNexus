import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { applyDueDisputeTimer } from './disputes.js'
import { recordLifecycle } from './metrics.js'

const DISPUTE_TIMER_INTERVAL_MS = 5 * 60 * 1000
const BATCH_SIZE = 50

let timer: NodeJS.Timeout | null = null
let running = false

async function runDisputeTimerBatch(now = new Date()): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (running) return counts
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('orderDisputeTimers', DISPUTE_TIMER_INTERVAL_MS)
    if (!lease) return counts
    const candidates = await prisma.order.findMany({
      where: {
        status: 'disputed',
        disputeEscalatedAt: null,
        OR: [
          { remedyRespondBy: { lte: now } },
          { remedyProposedAt: null, disputeRespondBy: { lte: now } },
        ],
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    })
    for (const { id } of candidates) {
      try {
        const outcome = await applyDueDisputeTimer(id, now)
        recordLifecycle('dispute_timer', outcome)
        counts[outcome] = (counts[outcome] ?? 0) + 1
      } catch (err) {
        recordLifecycle('dispute_timer', 'error')
        logger.warn({ err, orderId: id }, 'dispute timer failed for order')
      }
    }
    if (candidates.length > 0) logger.info({ counts }, 'dispute timers applied')
  } catch (err) {
    recordLifecycle('dispute_timer', 'error')
    logger.error({ err }, 'dispute timer cron batch failed')
  } finally {
    lease?.release()
    running = false
  }
  return counts
}

export function startDisputeTimerCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  void runDisputeTimerBatch()
  timer = setInterval(() => { void runDisputeTimerBatch() }, DISPUTE_TIMER_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: DISPUTE_TIMER_INTERVAL_MS }, 'order dispute timer cron started')
}

export function stopDisputeTimerCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export async function __runDisputeTimerBatchForTests(now?: Date) {
  return runDisputeTimerBatch(now)
}
