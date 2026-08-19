import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'

export const PAYMENT_PAYLOAD_DEFAULT_RETENTION_DAYS = 30
export const PAYMENT_PAYLOAD_HOLD_AFTER_CLOSE_DAYS = 180
const RETENTION_INTERVAL_MS = 60 * 60 * 1000
const BATCH_SIZE = 100

const OPEN_REFUND = ['requested', 'points_held', 'processing', 'manual_review'] as const
const OPEN_DISPUTE = ['open'] as const

let timer: NodeJS.Timeout | null = null
let running = false

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

export async function sweepExpiredPaymentPayloads(now = new Date()): Promise<number> {
  const defaultCutoff = daysAgo(PAYMENT_PAYLOAD_DEFAULT_RETENTION_DAYS, now)
  const candidates = await prisma.paymentEvent.findMany({
    where: {
      rawPayloadEncrypted: { not: null },
      createdAt: { lte: now },
    },
    select: {
      id: true,
      createdAt: true,
      paymentAttemptId: true,
      providerPaymentId: true,
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: 'asc' },
  })
  if (candidates.length === 0) return 0

  const attemptIds = [...new Set(candidates.map(item => item.paymentAttemptId).filter((id): id is string => Boolean(id)))]
  const eventIds = candidates.map(item => item.id)

  const [disputes, refunds, reconItems] = await Promise.all([
    attemptIds.length === 0
      ? Promise.resolve([])
      : prisma.paymentDispute.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { paymentAttemptId: true, status: true, closedAt: true },
      }),
    attemptIds.length === 0
      ? Promise.resolve([])
      : prisma.rechargeRefund.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { paymentAttemptId: true, status: true, completedAt: true, updatedAt: true },
      }),
    prisma.reconciliationItem.findMany({
      where: {
        OR: [
          { paymentEventId: { in: eventIds } },
          ...(attemptIds.length > 0 ? [{ paymentAttemptId: { in: attemptIds } }] : []),
        ],
      },
      select: { paymentEventId: true, paymentAttemptId: true, status: true, resolvedAt: true },
    }),
  ])

  const clearable: string[] = []
  for (const event of candidates) {
    const relatedDisputes = disputes.filter(item => item.paymentAttemptId === event.paymentAttemptId)
    const relatedRefunds = refunds.filter(item => item.paymentAttemptId === event.paymentAttemptId)
    const relatedRecon = reconItems.filter(item =>
      item.paymentEventId === event.id || (event.paymentAttemptId != null && item.paymentAttemptId === event.paymentAttemptId),
    )

    const openHold = relatedDisputes.some(item => (OPEN_DISPUTE as readonly string[]).includes(item.status))
      || relatedRefunds.some(item => (OPEN_REFUND as readonly string[]).includes(item.status))
      || relatedRecon.some(item => item.status === 'open')
    if (openHold) continue

    const closeTimes = [
      ...relatedDisputes.map(item => item.closedAt),
      ...relatedRefunds.map(item => item.completedAt ?? (item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled' ? item.updatedAt : null)),
      ...relatedRecon.map(item => item.resolvedAt),
    ].filter((value): value is Date => value instanceof Date)

    if (closeTimes.length > 0) {
      const latestClose = closeTimes.reduce((latest, value) => (value > latest ? value : latest))
      if (latestClose > daysAgo(PAYMENT_PAYLOAD_HOLD_AFTER_CLOSE_DAYS, now)) continue
      clearable.push(event.id)
      continue
    }

    if (event.createdAt <= defaultCutoff) clearable.push(event.id)
  }

  if (clearable.length === 0) return 0
  const updated = await prisma.paymentEvent.updateMany({
    where: { id: { in: clearable }, rawPayloadEncrypted: { not: null } },
    data: { rawPayloadEncrypted: null },
  })
  return updated.count
}

async function runRetentionBatch() {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('paymentPayloadRetention', RETENTION_INTERVAL_MS)
    if (!lease) return
    const cleared = await sweepExpiredPaymentPayloads()
    if (cleared > 0) {
      logger.info({ payloadsCleared: cleared }, 'payment raw payloads cleared after retention window')
    }
  } catch (err) {
    logger.error({ err }, 'payment payload retention batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startPaymentPayloadRetentionCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runRetentionBatch().catch(err => {
    logger.error({ err }, 'payment payload retention initial run failed')
  })
  timer = setInterval(() => {
    runRetentionBatch().catch(err => {
      logger.error({ err }, 'payment payload retention tick failed')
    })
  }, RETENTION_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: RETENTION_INTERVAL_MS }, 'payment payload retention cron started')
}

export function stopPaymentPayloadRetentionCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('payment payload retention cron stopped')
}

export async function __runPaymentPayloadRetentionForTests(now?: Date) {
  return sweepExpiredPaymentPayloads(now)
}
