import type { Prisma } from '@prisma/client'
import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { applyConfirmedPayment, writeOpenReconItem } from '../events/applyConfirmedPayment.js'
import { recordNormalizedPaymentFact } from '../observations/record.js'
import { getHistoricalProvider } from '../providers/registry.js'
import { executeRechargeCredit } from '../../recharge/credit.js'
import { applyRefundObservation, queryProviderRefund, submitProviderRefund } from '../../recharge/refund.js'
import { applyDisputeObservation } from '../disputes/service.js'
import { PAYMENT_PROVIDER_NAMES, type PaymentProviderName } from '../../recharge/types.js'
import {
  claimCreditTask,
  claimNextCreditTask,
} from './lease.js'
import {
  recordPaidNotCredited,
  recordPaymentObservationMetric,
  setSimulatorConfigured,
  setWorkerBacklog,
} from '../metrics.js'
import {
  isProviderCircuitOpen,
  recordProviderQueryFailure,
  recordProviderQuerySuccess,
} from '../providers/circuitBreaker.js'
import { config } from '../../../config/index.js'
import { applyTerminalPaymentState } from '../../recharge/paymentCompletion.js'
import { expireOrder, recoverProviderCreate } from '../../recharge/orderLifecycle.js'

const TICK_MS = 2_000
const PAID_NOT_CREDITED_MS = 30_000
const PAID_NOT_CREDITED_ALERT_MS = 120_000
const QUERY_STALE_MS = 15_000

let timer: NodeJS.Timeout | null = null
let running = false

function asProviderName(value: string): PaymentProviderName | null {
  return (PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value)
    ? value as PaymentProviderName
    : null
}

function providerQueryAttemptWhere(cutoff?: Date): Prisma.PaymentAttemptWhereInput {
  return {
    status: { in: ['unknown', 'processing', 'requires_action'] },
    providerPaymentId: { not: null },
    ...(cutoff ? { updatedAt: { lte: cutoff } } : {}),
    // Administrator sandbox confirmation is an explicit MFA-protected local
    // action. Simulator state is process-local, so provider query recovery is
    // neither authoritative nor durable for these orders after a deploy.
    paymentIntent: {
      rechargeOrder: {
        adminSandbox: false,
      },
    },
  }
}

// About 8 minutes of retries at the capped 16s backoff. A local apply that
// still throws by then is not transient; park it for an operator instead of
// retrying forever (admin event retry re-drives it).
export const OBSERVATION_MAX_ATTEMPTS = 30

/**
 * Applies the oldest due observation. A throwing apply is contained here so
 * one poison event cannot abort the rest of the worker tick; `skipIds` keeps
 * an event that failed without advancing its schedule from being re-picked
 * in the same tick.
 */
export async function processOneObservation(skipIds: Set<string> = new Set()): Promise<boolean> {
  const due = await prisma.paymentEvent.findFirst({
    where: {
      ...(skipIds.size > 0 ? { id: { notIn: [...skipIds] } } : {}),
      status: { in: ['received', 'processing', 'failed'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, eventType: true },
  })
  if (!due) return false
  try {
    if (due.eventType.startsWith('dispute.')) {
      await applyDisputeObservation(due.id)
    } else if (due.eventType.startsWith('refund.')) {
      await applyRefundObservation(due.id)
    } else {
      await applyConfirmedPayment(due.id)
    }
  } catch (error) {
    skipIds.add(due.id)
    logger.warn({ event: 'payment.observation_apply_failed', observationId: due.id, err: error instanceof Error ? error.message : 'apply_failed' },
      'payment observation apply failed; will retry with backoff')
    await parkExhaustedObservation(due.id)
  }
  return true
}

async function parkExhaustedObservation(id: string) {
  const event = await prisma.paymentEvent.findUnique({ where: { id } })
  if (!event || event.status !== 'failed' || event.attempts < OBSERVATION_MAX_ATTEMPTS) return
  const parked = await prisma.$transaction(async tx => {
    const updated = await tx.paymentEvent.updateMany({
      where: { id, status: 'failed', leaseToken: null },
      data: { status: 'reconcile_required', processedAt: new Date() },
    })
    if (updated.count !== 1) return false
    // Every reconcile_required exit needs an open item: it is the operator's
    // queue and keeps the raw payload past retention.
    await writeOpenReconItem(tx, {
      scopePrefix: 'exhausted',
      mismatchType: 'unknown_provider_transaction',
      attemptId: event.paymentAttemptId,
      eventId: event.id,
      provider: event.provider,
      providerAccountKey: event.providerAccountKey,
      providerEntryKey: `event:${event.id}`,
      providerStatus: event.eventType,
    })
    return true
  })
  if (parked) {
    recordPaymentObservationMetric(event.provider, event.source, 'reconcile_required')
    logger.error({ event: 'payment.observation_exhausted', observationId: id, attempts: event.attempts, lastErrorCode: event.lastErrorCode },
      'payment observation exhausted retries; parked as reconcile_required')
  }
}

export async function processOneCreditTask(): Promise<boolean> {
  const claimed = await claimNextCreditTask()
  if (!claimed) return false
  const task = await prisma.rechargeCreditTask.findUnique({ where: { id: claimed.id } })
  if (!task) return false
  try {
    await executeRechargeCredit({
      rechargeOrderId: task.rechargeOrderId,
      creditTaskId: task.id,
      leaseToken: claimed.leaseToken,
    })
  } catch (error) {
    // The credit already committed the task as failed with backoff; contain
    // the error so other tasks and worker stages still run this tick.
    logger.warn({ event: 'recharge.credit_task_failed', creditTaskId: task.id, err: error instanceof Error ? error.message : 'credit_failed' },
      'recharge credit task failed; will retry with backoff')
    await parkExhaustedCreditTask(task.id)
  }
  return true
}

/**
 * A task past maxAttempts moves its order to reconcile_required, where the
 * admin reconcile resolution can credit or refund it (and resets the task).
 */
async function parkExhaustedCreditTask(id: string) {
  const ref = await prisma.rechargeCreditTask.findUnique({ where: { id }, select: { rechargeOrderId: true } })
  if (!ref) return
  const parked = await prisma.$transaction(async tx => {
    // Same lock order as the credit path: RechargeOrder, then its task.
    await tx.$queryRaw`SELECT "id" FROM "RechargeOrder" WHERE "id" = ${ref.rechargeOrderId}::uuid FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "RechargeCreditTask" WHERE "id" = ${id}::uuid FOR UPDATE`
    const task = await tx.rechargeCreditTask.findUnique({ where: { id } })
    if (!task || task.status !== 'failed' || task.leaseToken || task.attempts < task.maxAttempts) return null
    await tx.rechargeCreditTask.update({
      where: { id },
      data: { status: 'reconcile_required', completedAt: new Date(), lastErrorCode: `MAX_ATTEMPTS:${task.lastErrorCode ?? 'unknown'}`.slice(0, 80) },
    })
    await tx.rechargeOrder.updateMany({
      where: { id: task.rechargeOrderId, status: 'paid' },
      data: { status: 'reconcile_required' },
    })
    return task
  })
  if (parked) {
    logger.error({ event: 'recharge.credit_task_exhausted', creditTaskId: id, rechargeOrderId: parked.rechargeOrderId, attempts: parked.attempts },
      'recharge credit task exhausted retries; order parked as reconcile_required')
  }
}

export async function recoverPaidNotCredited(): Promise<number> {
  const cutoff = new Date(Date.now() - PAID_NOT_CREDITED_MS)
  const orders = await prisma.rechargeOrder.findMany({
    where: {
      status: 'paid',
      creditedAt: null,
      updatedAt: { lte: cutoff },
    },
    take: 20,
    select: { id: true, creditTask: { select: { id: true } } },
  })
  const staleAlert = new Date(Date.now() - PAID_NOT_CREDITED_ALERT_MS)
  const alertOrders = await prisma.rechargeOrder.findMany({
    where: { status: 'paid', creditedAt: null, paidAt: { lte: staleAlert } },
    select: { provider: true },
  })
  for (const order of alertOrders) {
    recordPaidNotCredited(order.provider)
  }
  for (const order of orders) {
    try {
      if (order.creditTask) {
        const claimed = await claimCreditTask(order.creditTask.id)
        if (claimed) {
          await executeRechargeCredit({
            rechargeOrderId: order.id,
            creditTaskId: claimed.id,
            leaseToken: claimed.leaseToken,
          })
        }
      } else {
        await executeRechargeCredit({ rechargeOrderId: order.id })
      }
    } catch (error) {
      logger.warn({ event: 'recharge.paid_not_credited_retry', rechargeOrderId: order.id, err: error instanceof Error ? error.message : 'credit_failed' },
        'paid-not-credited recovery will retry')
      if (order.creditTask) await parkExhaustedCreditTask(order.creditTask.id)
    }
  }
  return orders.length
}

export async function recoverUnknownPayments(): Promise<number> {
  const cutoff = new Date(Date.now() - QUERY_STALE_MS)
  const attempts = await prisma.paymentAttempt.findMany({
    where: providerQueryAttemptWhere(cutoff),
    take: 20,
    include: { paymentIntent: { include: { rechargeOrder: true } } },
  })
  for (const attempt of attempts) {
    if (!attempt.providerPaymentId) continue
    const name = asProviderName(attempt.provider)
    if (!name) continue
    if (isProviderCircuitOpen(name)) continue
    const order = attempt.paymentIntent.rechargeOrder
    if (['credited', 'refunded', 'cancelled', 'expired', 'failed'].includes(order.status)) continue
    try {
      const provider = getHistoricalProvider(name)
      const queried = await provider.queryPayment({
        providerPaymentId: attempt.providerPaymentId,
        providerAccountKey: attempt.providerAccountKey,
        providerOrderId: attempt.providerOrderId,
      })
      const recorded = await recordNormalizedPaymentFact({
        source: 'provider_query',
        provider: attempt.provider,
        providerAccountKey: attempt.providerAccountKey,
        paymentAttemptId: attempt.id,
        payment: {
          status: queried.status,
          providerPaymentId: queried.providerPaymentId,
          providerCaptureId: queried.providerCaptureId,
          amountMinor: queried.amountMinor,
          currency: queried.currency,
          immutableStateVersion: queried.immutableStateVersion,
        },
      })
      recordProviderQuerySuccess(name)
      if (queried.status === 'succeeded') {
        await applyConfirmedPayment(recorded.id)
      } else if (queried.status === 'failed' || queried.status === 'cancelled') {
        await applyTerminalPaymentState({
          orderId: order.id,
          attemptId: attempt.id,
          status: queried.status,
        })
      }
    } catch (error) {
      recordProviderQueryFailure(name)
      recordPaymentObservationMetric(name, 'provider_query', 'query_failed')
      logger.warn({
        event: 'payment.query_recovery_failed',
        paymentAttemptId: attempt.id,
        err: error instanceof Error ? error.message : 'query_failed',
      }, 'query recovery failed')
    }
  }
  return attempts.length
}

export async function recoverUnfinishedCreates(): Promise<number> {
  const cutoff = new Date(Date.now() - QUERY_STALE_MS)
  const attempts = await prisma.paymentAttempt.findMany({
    where: { status: 'created', providerPaymentId: null, updatedAt: { lte: cutoff } },
    take: 20,
    select: { paymentIntent: { select: { rechargeOrderId: true } } },
  })
  for (const attempt of attempts) {
    try {
      await recoverProviderCreate(attempt.paymentIntent.rechargeOrderId)
    } catch (error) {
      logger.warn({
        event: 'payment.create_recovery_failed',
        rechargeOrderId: attempt.paymentIntent.rechargeOrderId,
        err: error instanceof Error ? error.message : 'create_failed',
      }, 'provider create recovery will retry with the stable idempotency key')
    }
  }
  return attempts.length
}

export async function expireDueRechargeOrders(): Promise<number> {
  const orders = await prisma.rechargeOrder.findMany({
    where: {
      status: { in: ['created', 'pending_payment', 'closure_pending'] },
      expiresAt: { lte: new Date() },
    },
    take: 20,
    select: { id: true, userId: true },
  })
  for (const order of orders) {
    try {
      await expireOrder(order.userId, order.id)
    } catch (error) {
      logger.warn({
        event: 'payment.order_expiry_failed',
        rechargeOrderId: order.id,
        err: error instanceof Error ? error.message : 'expiry_failed',
      }, 'expired recharge order closure will retry')
    }
  }
  return orders.length
}

const REFUND_PROCESSING_STALE_MS = 2_000

export async function processDueRefunds(): Promise<number> {
  const stale = new Date(Date.now() - REFUND_PROCESSING_STALE_MS)
  const refunds = await prisma.rechargeRefund.findMany({
    where: {
      OR: [
        { status: { in: ['requested', 'points_held'] } },
        { status: 'processing', updatedAt: { lte: stale } },
      ],
    },
    take: 20,
    select: { id: true, status: true, providerRefundId: true },
  })
  for (const refund of refunds) {
    try {
      if (refund.status === 'processing' && refund.providerRefundId) {
        await queryProviderRefund(refund.id)
      } else {
        await submitProviderRefund(refund.id)
      }
    } catch (error) {
      logger.warn({
        event: 'payment.refund_worker_retry',
        refundId: refund.id,
        err: error instanceof Error ? error.message : 'refund_failed',
      }, 'refund worker will retry')
    }
  }
  return refunds.length
}

async function refreshPaymentWorkerGauges() {
  const now = Date.now()
  const [dueEvents, dueCredits, dueRefunds, dueQueries] = await Promise.all([
    prisma.paymentEvent.findMany({
      where: { status: { in: ['received', 'processing', 'failed'] } },
      select: { nextAttemptAt: true, createdAt: true },
      take: 200,
    }),
    prisma.rechargeCreditTask.findMany({
      where: { status: { in: ['pending', 'processing', 'failed'] } },
      select: { nextAttemptAt: true, createdAt: true },
      take: 200,
    }),
    prisma.rechargeRefund.findMany({
      where: { status: { in: ['requested', 'points_held', 'processing'] } },
      select: { createdAt: true, updatedAt: true },
      take: 200,
    }),
    prisma.paymentAttempt.findMany({
      where: providerQueryAttemptWhere(),
      select: { updatedAt: true },
      take: 200,
    }),
  ])
  const age = (dates: Date[]) => {
    if (dates.length === 0) return 0
    const oldest = dates.reduce((min, value) => (value < min ? value : min))
    return Math.max(0, (now - oldest.getTime()) / 1000)
  }
  setWorkerBacklog('observation', dueEvents.length, age(dueEvents.map(item => item.nextAttemptAt ?? item.createdAt)))
  setWorkerBacklog('credit', dueCredits.length, age(dueCredits.map(item => item.nextAttemptAt ?? item.createdAt)))
  setWorkerBacklog('refund', dueRefunds.length, age(dueRefunds.map(item => item.updatedAt ?? item.createdAt)))
  setWorkerBacklog('query', dueQueries.length, age(dueQueries.map(item => item.updatedAt)))
  const simulatorListed = config.recharge.registeredProviders.includes('simulator')
    || config.recharge.enabledProviders.includes('simulator')
  const approvedAdministratorSandbox = config.recharge.mode === 'admin_sandbox'
    && config.recharge.adminSandboxEnabled
  setSimulatorConfigured(
    config.isProductionDeploy
      && simulatorListed
      && !approvedAdministratorSandbox,
  )
}

export async function runPaymentWorkersOnce() {
  const failedObservations = new Set<string>()
  for (let i = 0; i < 20; i += 1) {
    const worked = await processOneObservation(failedObservations)
    if (!worked) break
  }
  for (let i = 0; i < 20; i += 1) {
    const worked = await processOneCreditTask()
    if (!worked) break
  }
  await recoverPaidNotCredited()
  await recoverUnfinishedCreates()
  await recoverUnknownPayments()
  await expireDueRechargeOrders()
  await processDueRefunds()
  await refreshPaymentWorkerGauges()
}

async function tick() {
  if (running) return
  running = true
  try {
    await runPaymentWorkersOnce()
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : 'worker_tick' }, 'payment worker tick failed')
  } finally {
    running = false
  }
}

export function startPaymentWorkers() {
  if (timer) return
  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  timer.unref?.()
}

export function stopPaymentWorkers() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
