import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'

export const PAYMENT_PAYLOAD_DEFAULT_RETENTION_DAYS = 30
export const PAYMENT_PAYLOAD_HOLD_AFTER_CLOSE_DAYS = 180
export const PAYMENT_PAYLOAD_SWEEP_BATCH_SIZE = 100
const RETENTION_INTERVAL_MS = 60 * 60 * 1000

const OPEN_REFUND = ['requested', 'points_held', 'processing', 'manual_review'] as const
const OPEN_DISPUTE = ['open'] as const

let timer: NodeJS.Timeout | null = null
let running = false

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

type SweepCandidate = {
  id: string
  createdAt: Date
  paymentAttemptId: string | null
  rechargeOrderId?: string
}

async function selectClearableIds(db: Prisma.TransactionClient, candidates: SweepCandidate[], now: Date): Promise<string[]> {
  if (candidates.length === 0) return []
  const defaultCutoff = daysAgo(PAYMENT_PAYLOAD_DEFAULT_RETENTION_DAYS, now)
  const holdAfterCloseCutoff = daysAgo(PAYMENT_PAYLOAD_HOLD_AFTER_CLOSE_DAYS, now)
  const attemptIds = [...new Set(candidates.map(item => item.paymentAttemptId).filter((id): id is string => Boolean(id)))]
  const eventIds = candidates.map(item => item.id)
  const orderIds = candidates.flatMap(item => item.rechargeOrderId ? [item.rechargeOrderId] : [])
  const caseWhere = { OR: [{ paymentAttemptId: { in: attemptIds } }, { rechargeOrderId: { in: orderIds } }] }

  const [disputes, refunds, reconItems] = await Promise.all([
    attemptIds.length === 0 && orderIds.length === 0
      ? Promise.resolve([])
      : db.paymentDispute.findMany({
        where: caseWhere,
        select: { paymentAttemptId: true, rechargeOrderId: true, status: true, closedAt: true },
      }),
    attemptIds.length === 0 && orderIds.length === 0
      ? Promise.resolve([])
      : db.rechargeRefund.findMany({
        where: caseWhere,
        select: { paymentAttemptId: true, rechargeOrderId: true, status: true, completedAt: true, updatedAt: true },
      }),
    db.reconciliationItem.findMany({
      where: {
        OR: [
          { paymentEventId: { in: eventIds } },
          { rechargeOrderId: { in: orderIds } },
          ...(attemptIds.length > 0 ? [{ paymentAttemptId: { in: attemptIds } }] : []),
        ],
      },
      select: { paymentEventId: true, paymentAttemptId: true, rechargeOrderId: true, status: true, resolvedAt: true },
    }),
  ])

  const clearable: string[] = []
  for (const event of candidates) {
    const matchesCase = (item: { paymentAttemptId: string | null; rechargeOrderId: string | null }) =>
      (event.paymentAttemptId != null && item.paymentAttemptId === event.paymentAttemptId)
      || (event.rechargeOrderId != null && item.rechargeOrderId === event.rechargeOrderId)
    const relatedDisputes = disputes.filter(matchesCase)
    const relatedRefunds = refunds.filter(matchesCase)
    const relatedRecon = reconItems.filter(item =>
      item.paymentEventId === event.id || matchesCase(item),
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
      if (latestClose > holdAfterCloseCutoff) continue
      clearable.push(event.id)
      continue
    }

    if (event.createdAt <= defaultCutoff) clearable.push(event.id)
  }
  return clearable
}

/** Clears expired ciphertext only. SHA-256 and normalizedPayload stay. */
export async function sweepExpiredPaymentPayloads(now = new Date()): Promise<number> {
  let totalCleared = 0
  let cursor: { createdAt: Date; id: string } | null = null
  for (;;) {
    const afterCursor = cursor
    const candidates: SweepCandidate[] = await prisma.paymentEvent.findMany({
      where: {
        rawPayloadEncrypted: { not: null },
        status: { in: ['processed', 'ignored', 'reconcile_required'] },
        createdAt: { lte: daysAgo(PAYMENT_PAYLOAD_DEFAULT_RETENTION_DAYS, now) },
        ...(afterCursor
          ? {
              OR: [
                { createdAt: { gt: afterCursor.createdAt } },
                { AND: [{ createdAt: afterCursor.createdAt }, { id: { gt: afterCursor.id } }] },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        createdAt: true,
        paymentAttemptId: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAYMENT_PAYLOAD_SWEEP_BATCH_SIZE,
    })
    if (candidates.length === 0) break

    for (const candidate of candidates) {
      totalCleared += await prisma.$transaction(async tx => {
        // Same lock order as payment application: Event -> RechargeOrder.
        // Refund/dispute creation holds the order lock, reconciliation does too.
        const events = await tx.$queryRaw<SweepCandidate[]>`SELECT id, "createdAt", "paymentAttemptId"
          FROM "PaymentEvent" WHERE id = ${candidate.id}::uuid
            AND "rawPayloadEncrypted" IS NOT NULL
            AND status IN ('processed', 'ignored', 'reconcile_required') FOR UPDATE`
        const event = events[0]
        if (!event) return 0
        if (event.paymentAttemptId) {
          const attempt = await tx.paymentAttempt.findUnique({
            where: { id: event.paymentAttemptId },
            select: { paymentIntent: { select: { rechargeOrderId: true } } },
          })
          if (attempt) {
            event.rechargeOrderId = attempt.paymentIntent.rechargeOrderId
            await tx.$queryRaw`SELECT id FROM "RechargeOrder"
              WHERE id = ${event.rechargeOrderId}::uuid FOR UPDATE`
          }
        }
        const clearable = await selectClearableIds(tx, [event], now)
        if (!clearable.length) return 0
        const updated = await tx.paymentEvent.updateMany({
          where: { id: event.id, rawPayloadEncrypted: { not: null } },
          data: { rawPayloadEncrypted: null },
        })
        return updated.count
      })
    }

    const last: SweepCandidate = candidates[candidates.length - 1]!
    cursor = { createdAt: last.createdAt, id: last.id }
    if (candidates.length < PAYMENT_PAYLOAD_SWEEP_BATCH_SIZE) break
  }
  return totalCleared
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
