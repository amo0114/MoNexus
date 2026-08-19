import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { applyConfirmedPayment } from '../events/applyConfirmedPayment.js'
import { recordNormalizedPaymentFact } from '../observations/record.js'
import { getHistoricalProvider } from '../providers/registry.js'
import { executeRechargeCredit } from '../../recharge/credit.js'
import { applyRefundObservation, submitProviderRefund } from '../../recharge/refund.js'
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

export async function processOneObservation(): Promise<boolean> {
  const due = await prisma.paymentEvent.findFirst({
    where: {
      status: { in: ['received', 'processing', 'failed'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, eventType: true },
  })
  if (!due) return false
  if (due.eventType.startsWith('refund.')) {
    await applyRefundObservation(due.id)
  } else {
    await applyConfirmedPayment(due.id)
  }
  return true
}

export async function processOneCreditTask(): Promise<boolean> {
  const claimed = await claimNextCreditTask()
  if (!claimed) return false
  const task = await prisma.rechargeCreditTask.findUnique({ where: { id: claimed.id } })
  if (!task) return false
  await executeRechargeCredit({
    rechargeOrderId: task.rechargeOrderId,
    creditTaskId: task.id,
    leaseToken: claimed.leaseToken,
  })
  return true
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
  }
  return orders.length
}

export async function recoverUnknownPayments(): Promise<number> {
  const cutoff = new Date(Date.now() - QUERY_STALE_MS)
  const attempts = await prisma.paymentAttempt.findMany({
    where: {
      status: { in: ['unknown', 'processing', 'requires_action'] },
      providerPaymentId: { not: null },
      updatedAt: { lte: cutoff },
    },
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
    select: { id: true },
  })
  for (const refund of refunds) {
    try {
      await submitProviderRefund(refund.id)
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
      where: { status: { in: ['unknown', 'processing', 'requires_action'] }, providerPaymentId: { not: null } },
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
  setSimulatorConfigured(config.isProductionDeploy && simulatorListed)
}

export async function runPaymentWorkersOnce() {
  for (let i = 0; i < 20; i += 1) {
    const worked = await processOneObservation()
    if (!worked) break
  }
  for (let i = 0; i < 20; i += 1) {
    const worked = await processOneCreditTask()
    if (!worked) break
  }
  await recoverPaidNotCredited()
  await recoverUnknownPayments()
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
