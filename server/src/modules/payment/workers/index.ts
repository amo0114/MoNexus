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

const TICK_MS = 2_000
const PAID_NOT_CREDITED_MS = 30_000
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
      if (queried.status === 'succeeded') {
        await applyConfirmedPayment(recorded.id)
      }
    } catch (error) {
      logger.warn({
        event: 'payment.query_recovery_failed',
        paymentAttemptId: attempt.id,
        err: error instanceof Error ? error.message : 'query_failed',
      }, 'query recovery failed')
    }
  }
  return attempts.length
}

export async function processDueRefunds(): Promise<number> {
  const refunds = await prisma.rechargeRefund.findMany({
    where: { status: { in: ['requested', 'points_held'] } },
    take: 20,
    select: { id: true },
  })
  for (const refund of refunds) {
    await submitProviderRefund(refund.id)
  }
  return refunds.length
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
