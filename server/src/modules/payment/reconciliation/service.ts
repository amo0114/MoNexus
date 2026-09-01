import { randomUUID } from 'node:crypto'
import { conflict, notFound } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { getHistoricalProvider } from '../providers/registry.js'
import { recordNormalizedPaymentFact } from '../observations/record.js'
import { applyConfirmedPayment } from '../events/applyConfirmedPayment.js'
import { applyRefundObservation } from '../../recharge/refund.js'
import { serializeAmountMinor } from '../../recharge/money.js'
import type { PaymentProviderName, ReconciliationScopeType } from '../../recharge/types.js'
import { PAYMENT_PROVIDER_NAMES } from '../../recharge/types.js'
import { providerEnvironment } from '../../recharge/gates.js'
import { recordAmountMismatch, recordReconciliationMismatch } from '../metrics.js'

const TX = { timeout: 20_000, maxWait: 5_000 } as const

function asProviderName(value: string): PaymentProviderName {
  if (!(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value)) {
    throw conflict('支付渠道不可用')
  }
  return value as PaymentProviderName
}

export async function createReconciliationRun(input: {
  provider: string
  providerAccountKey?: string
  scopeType: ReconciliationScopeType
  scopeKey?: string
  createdByUserId?: number
  periodStart?: Date
  periodEnd?: Date
}) {
  const providerName = asProviderName(input.provider)
  const adapter = getHistoricalProvider(providerName)
  const environment = providerEnvironment()
  const accountKey = input.providerAccountKey
    ?? (await adapter.selectAccount({
      environment,
      currency: 'CNY',
      paymentMethod: 'card',
    })).providerAccountKey
  const scopeKey = input.scopeKey ?? `${input.scopeType}:${new Date().toISOString().slice(0, 10)}:${randomUUID()}`

  const run = await prisma.reconciliationRun.upsert({
    where: {
      provider_providerAccountKey_environment_scopeType_scopeKey: {
        provider: providerName,
        providerAccountKey: accountKey,
        environment,
        scopeType: input.scopeType,
        scopeKey,
      },
    },
    create: {
      provider: providerName,
      providerAccountKey: accountKey,
      environment,
      scopeType: input.scopeType,
      scopeKey,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      status: 'pending',
      createdByUserId: input.createdByUserId ?? null,
    },
    update: {},
  })
  return executeReconciliationRun(run.id)
}

export async function executeReconciliationRun(runId: string) {
  const run = await prisma.reconciliationRun.findUnique({ where: { id: runId } })
  if (!run) throw notFound('对账批次不存在')
  const claimed = await prisma.reconciliationRun.updateMany({
    where: { id: runId, status: { in: ['pending', 'failed'] } },
    data: { status: 'running', startedAt: new Date(), lastErrorCode: null },
  })
  if (claimed.count !== 1 && run.status !== 'running') {
    return serializeRun(await prisma.reconciliationRun.findUniqueOrThrow({ where: { id: runId }, include: { items: true } }))
  }

  try {
    const adapter = getHistoricalProvider(asProviderName(run.provider))
    let itemCount = 0
    let mismatchCount = 0

    if (adapter.listReconciliationEntries) {
      for await (const entry of adapter.listReconciliationEntries({
        providerAccountKey: run.providerAccountKey,
        environment: run.environment as 'sandbox' | 'live',
        periodStart: run.periodStart ?? undefined,
        periodEnd: run.periodEnd ?? undefined,
      })) {
        itemCount += 1
        const attempt = entry.providerPaymentId
          ? await prisma.paymentAttempt.findFirst({
            where: {
              provider: run.provider,
              providerAccountKey: run.providerAccountKey,
              providerPaymentId: entry.providerPaymentId,
            },
            include: { paymentIntent: { include: { rechargeOrder: true } } },
          })
          : null
        const order = attempt?.paymentIntent.rechargeOrder
        const expectedProviderAmountMinor = attempt?.expectedProviderAmountMinor ?? order?.amountMinor ?? null
        const quotedAmountMinor = order?.amountMinor ?? null
        const providerPaid = entry.status === 'succeeded' || entry.status === 'paid'
        if (providerPaid && (!order || !['paid', 'credited', 'refund_pending', 'refunded'].includes(order.status))) {
          mismatchCount += 1
          await upsertItem(run.id, {
            providerEntryKey: entry.providerEntryKey,
            rechargeOrderId: order?.id ?? null,
            paymentAttemptId: attempt?.id ?? null,
            mismatchType: order ? 'provider_paid_local_unpaid' : 'unknown_provider_transaction',
            providerStatus: entry.status,
            localStatus: order?.status ?? null,
            providerAmountMinor: entry.amountMinor,
            localAmountMinor: expectedProviderAmountMinor,
            quotedAmountMinor,
            currency: entry.currency,
          })
          if (attempt && providerPaid) {
            const recorded = await recordNormalizedPaymentFact({
              source: 'reconciliation',
              provider: run.provider,
              providerAccountKey: run.providerAccountKey,
              paymentAttemptId: attempt.id,
              payment: {
                status: 'succeeded',
                providerPaymentId: entry.providerPaymentId ?? entry.providerEntryKey,
                amountMinor: entry.amountMinor,
                currency: entry.currency,
                immutableStateVersion: `recon:${entry.status}`,
              },
            })
            await applyConfirmedPayment(recorded.id)
          }
        } else if (order && ['paid', 'credited'].includes(order.status) && !providerPaid) {
          mismatchCount += 1
          await upsertItem(run.id, {
            providerEntryKey: entry.providerEntryKey,
            rechargeOrderId: order.id,
            paymentAttemptId: attempt?.id ?? null,
            mismatchType: 'local_paid_provider_not_paid',
            providerStatus: entry.status,
            localStatus: order.status,
            providerAmountMinor: entry.amountMinor,
            localAmountMinor: expectedProviderAmountMinor,
            quotedAmountMinor,
            currency: entry.currency,
          })
        } else if (order && order.status === 'paid' && !order.creditedAt) {
          mismatchCount += 1
          await upsertItem(run.id, {
            providerEntryKey: entry.providerEntryKey,
            rechargeOrderId: order.id,
            paymentAttemptId: attempt?.id ?? null,
            mismatchType: 'paid_not_credited',
            providerStatus: entry.status,
            localStatus: order.status,
            providerAmountMinor: entry.amountMinor,
            localAmountMinor: expectedProviderAmountMinor,
            quotedAmountMinor,
            currency: entry.currency,
          })
        } else if (order && expectedProviderAmountMinor != null && entry.amountMinor !== expectedProviderAmountMinor) {
          mismatchCount += 1
          await upsertItem(run.id, {
            providerEntryKey: entry.providerEntryKey,
            rechargeOrderId: order.id,
            paymentAttemptId: attempt?.id ?? null,
            mismatchType: 'amount_mismatch',
            providerStatus: entry.status,
            localStatus: order.status,
            providerAmountMinor: entry.amountMinor,
            localAmountMinor: expectedProviderAmountMinor,
            quotedAmountMinor,
            currency: entry.currency,
          })
        } else if (order && entry.currency !== order.currency) {
          mismatchCount += 1
          await upsertItem(run.id, {
            providerEntryKey: entry.providerEntryKey,
            rechargeOrderId: order.id,
            paymentAttemptId: attempt?.id ?? null,
            mismatchType: 'currency_mismatch',
            providerStatus: entry.status,
            localStatus: order.status,
            providerAmountMinor: entry.amountMinor,
            localAmountMinor: expectedProviderAmountMinor,
            quotedAmountMinor,
            currency: entry.currency,
          })
        }
      }
    }

    const paidNotCredited = await prisma.rechargeOrder.findMany({
      where: { status: 'paid', creditedAt: null, provider: run.provider },
      take: 100,
    })
    for (const order of paidNotCredited) {
      mismatchCount += 1
      itemCount += 1
      await upsertItem(run.id, {
        providerEntryKey: `paid-not-credited:${order.id}`,
        rechargeOrderId: order.id,
        paymentAttemptId: null,
        mismatchType: 'paid_not_credited',
        providerStatus: null,
        localStatus: order.status,
        providerAmountMinor: null,
        localAmountMinor: order.amountMinor,
        quotedAmountMinor: order.amountMinor,
        currency: order.currency,
      })
    }

    const updated = await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: mismatchCount > 0 ? 'completed_with_mismatches' : 'completed',
        itemCount,
        mismatchCount,
        completedAt: new Date(),
      },
      include: { items: true },
    })
    return serializeRun(updated)
  } catch (error) {
    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        lastErrorCode: error instanceof Error ? error.message.slice(0, 80) : 'recon_failed',
        completedAt: new Date(),
      },
    })
    throw error
  }
}

async function upsertItem(runId: string, item: {
  providerEntryKey: string
  rechargeOrderId: string | null
  paymentAttemptId: string | null
  mismatchType: string
  providerStatus: string | null
  localStatus: string | null
  providerAmountMinor: bigint | null
  localAmountMinor: bigint | null
  quotedAmountMinor?: bigint | null
  currency: string | null
}) {
  await prisma.reconciliationItem.upsert({
    where: {
      reconciliationRunId_providerEntryKey_mismatchType: {
        reconciliationRunId: runId,
        providerEntryKey: item.providerEntryKey,
        mismatchType: item.mismatchType,
      },
    },
    create: {
      reconciliationRunId: runId,
      ...item,
      quotedAmountMinor: item.quotedAmountMinor ?? null,
      status: 'open',
    },
    update: {
      providerStatus: item.providerStatus,
      localStatus: item.localStatus,
      providerAmountMinor: item.providerAmountMinor,
      localAmountMinor: item.localAmountMinor,
      quotedAmountMinor: item.quotedAmountMinor ?? null,
    },
  })
  const run = await prisma.reconciliationRun.findUnique({
    where: { id: runId },
    select: { provider: true },
  })
  const providerName = run?.provider ?? 'unknown'
  recordReconciliationMismatch(providerName, item.mismatchType)
  if (item.mismatchType === 'amount_mismatch' || item.mismatchType === 'currency_mismatch') {
    recordAmountMismatch(providerName, item.currency ?? 'other')
  }
}

export async function reconcileOrder(orderId: string) {
  const order = await prisma.rechargeOrder.findUnique({
    where: { id: orderId },
    include: { paymentIntent: { include: { attempts: true } }, refund: true },
  })
  if (!order) throw notFound('充值订单不存在')
  const attempt = order.paymentIntent?.attempts.find(item => item.providerPaymentId)
    ?? order.paymentIntent?.attempts.at(-1)
  if (!attempt?.providerPaymentId) throw conflict('没有可对账的支付尝试')

  const adapter = getHistoricalProvider(asProviderName(order.provider))
  const queried = await adapter.queryPayment({
    providerPaymentId: attempt.providerPaymentId,
    providerAccountKey: order.providerAccountKey,
    providerOrderId: attempt.providerOrderId,
  })
  const recorded = await recordNormalizedPaymentFact({
    source: 'reconciliation',
    provider: order.provider,
    providerAccountKey: order.providerAccountKey,
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
  const applied = queried.status === 'succeeded'
    ? await applyConfirmedPayment(recorded.id)
    : await applyRefundObservation(recorded.id)

  if (order.refund) {
    const refund = await prisma.rechargeRefund.findUnique({ where: { rechargeOrderId: order.id } })
    if (refund?.providerRefundId) {
      const refundResult = await adapter.queryRefund({
        providerRefundId: refund.providerRefundId,
        providerAccountKey: order.providerAccountKey,
      })
      const refundObs = await recordNormalizedPaymentFact({
        source: 'reconciliation',
        provider: order.provider,
        providerAccountKey: order.providerAccountKey,
        paymentAttemptId: attempt.id,
        eventType: `refund.${refundResult.status}`,
        payment: {
          status: refundResult.status,
          providerPaymentId: attempt.providerPaymentId,
          amountMinor: refundResult.amountMinor,
          currency: refundResult.currency,
          immutableStateVersion: refundResult.immutableStateVersion,
          providerRefundId: refundResult.providerRefundId,
        },
      })
      await applyRefundObservation(refundObs.id)
    }
  }

  const fresh = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.id } })
  return {
    orderId: fresh.id,
    status: fresh.status,
    observationId: recorded.id,
    apply: applied,
  }
}

export function serializeRun(run: {
  id: string
  provider: string
  providerAccountKey: string
  environment: string
  scopeType: string
  scopeKey: string
  status: string
  itemCount: number
  mismatchCount: number
  startedAt: Date | null
  completedAt: Date | null
  lastErrorCode: string | null
  createdAt: Date
  items?: Array<{
    id: string
    providerEntryKey: string
    rechargeOrderId: string | null
    mismatchType: string
    providerStatus: string | null
    localStatus: string | null
    providerAmountMinor: bigint | null
    localAmountMinor: bigint | null
    quotedAmountMinor?: bigint | null
    currency: string | null
    status: string
  }>
}) {
  return {
    id: run.id,
    provider: run.provider,
    environment: run.environment,
    scopeType: run.scopeType,
    scopeKey: run.scopeKey,
    status: run.status,
    itemCount: run.itemCount,
    mismatchCount: run.mismatchCount,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    lastErrorCode: run.lastErrorCode,
    createdAt: run.createdAt.toISOString(),
    items: (run.items ?? []).map(item => ({
      id: item.id,
      providerEntryKey: item.providerEntryKey,
      rechargeOrderId: item.rechargeOrderId,
      mismatchType: item.mismatchType,
      providerStatus: item.providerStatus,
      localStatus: item.localStatus,
      providerAmountMinor: item.providerAmountMinor == null ? null : serializeAmountMinor(item.providerAmountMinor),
      localAmountMinor: item.localAmountMinor == null ? null : serializeAmountMinor(item.localAmountMinor),
      quotedAmountMinor: item.quotedAmountMinor == null ? null : serializeAmountMinor(item.quotedAmountMinor),
      currency: item.currency,
      status: item.status,
    })),
  }
}

void TX
