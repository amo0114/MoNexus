import { reconciliationPaymentSelection } from '../providers/runtime.js'
import { randomUUID } from 'node:crypto'
import { conflict, notFound, paymentRefundNotSupported } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { resolveHistoricalProvider } from '../providers/registry.js'
import { recordNormalizedPaymentFact } from '../observations/record.js'
import { applyConfirmedPayment } from '../events/applyConfirmedPayment.js'
import { applyRefundObservation, providerSupportsRefunds, REFUND_BUSINESS_EVENT_KEY } from '../../recharge/refund.js'
import { executeRechargeCredit } from '../../recharge/credit.js'
import { serializeAmountMinor } from '../../recharge/money.js'
import type { PaymentProviderName, ReconciliationScopeType } from '../../recharge/types.js'
import { PAYMENT_PROVIDER_NAMES } from '../../recharge/types.js'
import { providerEnvironment } from '../../recharge/gates.js'
import { recordAmountMismatch, recordReconciliationMismatch } from '../metrics.js'
import { parseStatementCsv } from './statementImport.js'

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
  const selection = await reconciliationPaymentSelection(providerName, input.providerAccountKey)
  const adapter = selection?.provider ?? await resolveHistoricalProvider(providerName)
  const environment = selection?.environment ?? providerEnvironment()
  const accountKey = input.providerAccountKey
    ?? selection?.providerAccountKey
    ?? (await adapter.selectAccount({
      environment,
      currency: 'CNY',
      paymentMethod: 'card',
    })).providerAccountKey
  if (input.scopeType === 'statement') throw conflict('账单对账请使用账单导入')
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
      providerCredentialRevisionId: selection?.revisionId ?? null,
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

/**
 * Preview a statement file: what would be matched, rejected and deduplicated.
 * Nothing is stored; the import call re-parses the same bytes.
 */
export function previewStatementImport(input: { csv: string; periodStart: Date; periodEnd: Date }) {
  if (input.periodEnd <= input.periodStart) throw conflict('账单区间无效')
  const parsed = parseStatementCsv(input.csv, { start: input.periodStart, end: input.periodEnd })
  return {
    formatVersion: parsed.formatVersion,
    sha256: parsed.sha256,
    validRows: parsed.entries.length,
    invalidRows: parsed.invalid,
    duplicateLines: parsed.duplicates,
    totals: parsed.totals,
  }
}

/**
 * Import a statement as a run keyed by its SHA-256: the same file for the same
 * account/environment maps to the same run, so a retry resumes it instead of
 * producing a second set of items. The raw file is not retained.
 */
export async function importStatement(input: {
  provider: string
  providerAccountKey: string
  periodStart: Date
  periodEnd: Date
  csv: string
  createdByUserId: number
}) {
  const providerName = asProviderName(input.provider)
  if (input.periodEnd <= input.periodStart) throw conflict('账单区间无效')
  const parsed = parseStatementCsv(input.csv, { start: input.periodStart, end: input.periodEnd })
  if (parsed.invalid.length > 0) throw conflict(`账单存在 ${parsed.invalid.length} 行无效数据，请先修正`)
  if (parsed.entries.length === 0) throw conflict('账单没有可导入的行')
  const selection = await reconciliationPaymentSelection(providerName, input.providerAccountKey)
  const environment = selection?.environment ?? providerEnvironment()
  const scopeKey = `sha256:${parsed.sha256}`
  const run = await prisma.reconciliationRun.upsert({
    where: {
      provider_providerAccountKey_environment_scopeType_scopeKey: {
        provider: providerName,
        providerAccountKey: input.providerAccountKey,
        environment,
        scopeType: 'statement',
        scopeKey,
      },
    },
    create: {
      providerCredentialRevisionId: selection?.revisionId ?? null,
      provider: providerName,
      providerAccountKey: input.providerAccountKey,
      environment,
      scopeType: 'statement',
      scopeKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sourceSha256: parsed.sha256,
      status: 'pending',
      createdByUserId: input.createdByUserId,
    },
    update: {},
  })
  return executeReconciliationRun(run.id, { entries: parsed.entries, formatVersion: parsed.formatVersion })
}

type ReconEntry = {
  providerEntryKey: string
  providerPaymentId?: string | null
  status: string
  amountMinor: bigint
  currency: string
}

type StatementSource = 'provider_api' | 'imported_file' | 'unsupported'

export async function executeReconciliationRun(
  runId: string,
  statement?: { entries: ReconEntry[]; formatVersion: string },
) {
  const run = await prisma.reconciliationRun.findUnique({ where: { id: runId } })
  if (!run) throw notFound('对账批次不存在')
  if (run.scopeType === 'statement' && !statement) throw conflict('账单对账需重新上传原账单文件')
  const claimed = await prisma.reconciliationRun.updateMany({
    where: { id: runId, status: { in: ['pending', 'failed'] } },
    data: { status: 'running', startedAt: new Date(), lastErrorCode: null },
  })
  if (claimed.count !== 1 && run.status !== 'running') {
    return serializeRun(await prisma.reconciliationRun.findUniqueOrThrow({ where: { id: runId }, include: { items: { take: RUN_ITEM_PREVIEW } } }))
  }

  try {
    const adapter = await resolveHistoricalProvider(asProviderName(run.provider), run.providerCredentialRevisionId)
    let itemCount = 0
    let mismatchCount = 0
    let providerEntries = 0

    // Only rows the provider itself listed may drive a payment fact directly;
    // an uploaded file only opens items, compensated through a fresh query.
    let source: StatementSource
    let entries: AsyncIterable<ReconEntry> | Iterable<ReconEntry> | null
    if (statement) {
      source = 'imported_file'
      entries = statement.entries
    } else if (adapter.listReconciliationEntries) {
      source = 'provider_api'
      entries = adapter.listReconciliationEntries({
        providerAccountKey: run.providerAccountKey,
        environment: run.environment as 'sandbox' | 'live',
        periodStart: run.periodStart ?? undefined,
        periodEnd: run.periodEnd ?? undefined,
      })
    } else {
      source = 'unsupported'
      entries = null
    }
    if (entries) {
      for await (const entry of entries) {
        providerEntries += 1
        itemCount += 1
        mismatchCount += await matchProviderEntry(run, entry, source === 'provider_api')
      }
    }

    const local = await scanPaidNotCredited(run)
    itemCount += local.mismatches
    mismatchCount += local.mismatches

    const updated = await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: mismatchCount > 0 ? 'completed_with_mismatches' : 'completed',
        itemCount,
        mismatchCount,
        completedAt: new Date(),
        coverage: {
          statementSource: source,
          formatVersion: statement?.formatVersion ?? null,
          providerEntries,
          localScanned: local.scanned,
          periodStart: run.periodStart?.toISOString() ?? null,
          periodEnd: run.periodEnd?.toISOString() ?? null,
        },
      },
      include: { items: { take: RUN_ITEM_PREVIEW } },
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

const RUN_ITEM_PREVIEW = 50
const LOCAL_SCAN_PAGE = 200

type RunScope = {
  id: string
  provider: string
  providerAccountKey: string
  periodStart: Date | null
  periodEnd: Date | null
}

async function matchProviderEntry(run: RunScope, entry: ReconEntry, autoApply: boolean): Promise<number> {
  let mismatches = 0
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
    mismatches += 1
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
    if (attempt && providerPaid && autoApply) {
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
    mismatches += 1
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
    mismatches += 1
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
    mismatches += 1
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
    mismatches += 1
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
  return mismatches
}

/**
 * Local integrity check over the run's whole scope (provider account and the
 * half-open period), paged by the stable (createdAt, id) cursor.
 */
async function scanPaidNotCredited(run: RunScope) {
  let scanned = 0
  let mismatches = 0
  let cursor: { createdAt: Date; id: string } | null = null
  for (;;) {
    const page: Array<{ id: string; status: string; amountMinor: bigint; currency: string; createdAt: Date }> = await prisma.rechargeOrder.findMany({
      where: {
        status: 'paid',
        creditedAt: null,
        provider: run.provider,
        providerAccountKey: run.providerAccountKey,
        ...(run.periodStart || run.periodEnd
          ? { createdAt: { ...(run.periodStart ? { gte: run.periodStart } : {}), ...(run.periodEnd ? { lt: run.periodEnd } : {}) } }
          : {}),
        ...(cursor
          ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] }
          : {}),
      },
      select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LOCAL_SCAN_PAGE,
    })
    for (const order of page) {
      scanned += 1
      mismatches += 1
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
    if (page.length < LOCAL_SCAN_PAGE) break
    const last = page[page.length - 1]
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  return { scanned, mismatches }
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
  await prisma.$transaction(async tx => {
    // Serialize new holds with raw-payload retention, as refunds/disputes do.
    const orderId = item.rechargeOrderId ?? (item.paymentAttemptId
      ? (await tx.paymentAttempt.findUnique({ where: { id: item.paymentAttemptId }, select: { paymentIntent: { select: { rechargeOrderId: true } } } }))?.paymentIntent.rechargeOrderId
      : null)
    if (orderId) await tx.$queryRaw`SELECT id FROM "RechargeOrder" WHERE id = ${orderId}::uuid FOR UPDATE`
    await tx.reconciliationItem.upsert({
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

  const adapter = await resolveHistoricalProvider(asProviderName(order.provider), order.providerCredentialRevisionId)
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

export type ReconcileResolution = 'credit' | 'refund'

/**
 * Operator exit for a `reconcile_required` order. Every automatic path refuses to
 * move such an order (late success, failed credit, unknown create), so without
 * this the user's payment can be neither credited nor refunded.
 *
 * Acts only on a fresh provider query proving the attempt was paid in full;
 * otherwise the order stays for manual investigation. `credit` re-enters the
 * normal paid -> credit pipeline (recoverPaidNotCredited covers a crash before
 * the inline credit); `refund` creates a `requested` refund that
 * processDueRefunds submits. No points are reversed because none were credited.
 */
export async function resolveReconcileRequiredOrder(input: {
  orderId: string
  action: ReconcileResolution
  actorUserId: number
}) {
  const order = await prisma.rechargeOrder.findUnique({
    where: { id: input.orderId },
    include: { paymentIntent: { include: { attempts: true } } },
  })
  if (!order) throw notFound('充值订单不存在')
  if (order.status !== 'reconcile_required') throw conflict('订单不在待人工对账状态')
  const intent = order.paymentIntent
  const attempt = intent?.attempts.find(item => item.providerPaymentId && item.status === 'succeeded')
    ?? intent?.attempts.find(item => item.providerPaymentId)
  if (!intent || !attempt?.providerPaymentId) throw conflict('没有可核验的支付尝试')

  const queried = await (await resolveHistoricalProvider(asProviderName(order.provider), order.providerCredentialRevisionId)).queryPayment({
    providerPaymentId: attempt.providerPaymentId,
    providerAccountKey: order.providerAccountKey,
    providerOrderId: attempt.providerOrderId,
  })
  if (
    queried.status !== 'succeeded'
    || queried.providerPaymentId !== attempt.providerPaymentId
    || queried.amountMinor !== attempt.expectedProviderAmountMinor
    || queried.currency !== order.currency
  ) {
    throw conflict('渠道未确认该笔全额支付成功，需继续人工核查')
  }
  if (input.action === 'refund' && !await providerSupportsRefunds(order)) {
    throw paymentRefundNotSupported()
  }

  const now = new Date()
  await prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "RechargeOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`
    if (locked[0]?.status !== 'reconcile_required') throw conflict('订单状态已变化，请刷新后重试')

    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'succeeded',
        providerCaptureId: queried.providerCaptureId ?? attempt.providerCaptureId,
        completedAt: attempt.completedAt ?? now,
      },
    })
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'succeeded', activeAttemptId: attempt.id },
    })

    if (input.action === 'credit') {
      await tx.rechargeOrder.update({
        where: { id: order.id },
        data: { status: 'paid', paidAt: order.paidAt ?? now },
      })
      // A credit that previously ended in reconcile_required left its task terminal.
      await tx.rechargeCreditTask.upsert({
        where: { rechargeOrderId: order.id },
        create: { rechargeOrderId: order.id, status: 'pending' },
        update: { status: 'pending', nextAttemptAt: now, leaseToken: null, leaseUntil: null, lastErrorCode: null },
      })
    } else {
      await tx.rechargeOrder.update({
        where: { id: order.id },
        data: { status: 'refund_pending', paidAt: order.paidAt ?? now },
      })
      await tx.rechargeRefund.create({
        data: {
          rechargeOrderId: order.id,
          paymentAttemptId: attempt.id,
          requestIdempotencyKey: REFUND_BUSINESS_EVENT_KEY(order.id),
          amountMinor: order.amountMinor,
          pointsToReverse: order.totalPoints,
          status: 'requested',
          reasonCode: 'reconcile_refund',
          createdByUserId: input.actorUserId,
        },
      })
    }

    await tx.reconciliationItem.updateMany({
      where: { rechargeOrderId: order.id, status: 'open' },
      data: {
        status: 'resolved',
        resolutionReason: `manual_${input.action}`,
        resolvedByUserId: input.actorUserId,
        resolvedAt: now,
      },
    })
  }, TX)

  if (input.action === 'credit') {
    await executeRechargeCredit({ rechargeOrderId: order.id })
  }
  const fresh = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.id } })
  return { orderId: fresh.id, status: fresh.status }
}

/**
 * Operator review of a single reconciliation item (the work queue that every
 * reconcile_required exit opens). Closing an item starts its raw-payload
 * retention clock. Items of a reconcile_required order are closed by the
 * order resolution instead, so the order cannot be left stuck behind a
 * closed item.
 */
export async function reviewReconciliationItem(input: {
  itemId: string
  status: 'resolved' | 'ignored'
  reason: string
  actorUserId: number
}) {
  const item = await prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ status: string; rechargeOrderId: string | null }>>`
      SELECT "status", "rechargeOrderId" FROM "ReconciliationItem" WHERE "id" = ${input.itemId}::uuid FOR UPDATE`
    const row = locked[0]
    if (!row) throw notFound('对账项不存在')
    if (row.status !== 'open') throw conflict('对账项已处理')
    if (row.rechargeOrderId) {
      const order = await tx.rechargeOrder.findUnique({ where: { id: row.rechargeOrderId }, select: { status: true } })
      if (order?.status === 'reconcile_required') throw conflict('该订单待人工处置，请使用订单处置接口')
    }
    return tx.reconciliationItem.update({
      where: { id: input.itemId },
      data: {
        status: input.status,
        resolutionReason: input.reason,
        resolvedByUserId: input.actorUserId,
        resolvedAt: new Date(),
      },
    })
  }, TX)
  return serializeReconItem(item)
}

export function serializeReconItem(item: {
  id: string
  reconciliationRunId: string
  providerEntryKey: string
  rechargeOrderId: string | null
  paymentAttemptId: string | null
  paymentEventId: string | null
  mismatchType: string
  providerStatus: string | null
  localStatus: string | null
  providerAmountMinor: bigint | null
  localAmountMinor: bigint | null
  quotedAmountMinor: bigint | null
  currency: string | null
  status: string
  resolutionReason: string | null
  resolvedByUserId: number | null
  resolvedAt: Date | null
  createdAt: Date
}) {
  return {
    id: item.id,
    runId: item.reconciliationRunId,
    providerEntryKey: item.providerEntryKey,
    rechargeOrderId: item.rechargeOrderId,
    paymentAttemptId: item.paymentAttemptId,
    paymentEventId: item.paymentEventId,
    mismatchType: item.mismatchType,
    providerStatus: item.providerStatus,
    localStatus: item.localStatus,
    providerAmountMinor: item.providerAmountMinor == null ? null : serializeAmountMinor(item.providerAmountMinor),
    localAmountMinor: item.localAmountMinor == null ? null : serializeAmountMinor(item.localAmountMinor),
    quotedAmountMinor: item.quotedAmountMinor == null ? null : serializeAmountMinor(item.quotedAmountMinor),
    currency: item.currency,
    status: item.status,
    resolutionReason: item.resolutionReason,
    resolvedByUserId: item.resolvedByUserId,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    allowedActions: reconItemActions(item),
  }
}

/**
 * Review (resolved/ignored) is an operator judgment; requery is the only path
 * to an economic change (fresh provider query -> observation -> credit/refund).
 * A reconcile_required order is decided through its own resolution endpoint.
 */
export function reconItemActions(item: { status: string; rechargeOrderId: string | null; localStatus: string | null }) {
  if (item.status !== 'open') return []
  if (item.localStatus === 'reconcile_required') return ['resolve_order']
  return item.rechargeOrderId ? ['requery_order', 'resolve', 'ignore'] : ['resolve', 'ignore']
}

export function serializeRun(run: {
  id: string
  provider: string
  providerAccountKey: string
  environment: string
  scopeType: string
  scopeKey: string
  periodStart?: Date | null
  periodEnd?: Date | null
  sourceSha256?: string | null
  coverage?: unknown
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
    providerAccountKey: run.providerAccountKey,
    environment: run.environment,
    scopeType: run.scopeType,
    scopeKey: run.scopeKey,
    periodStart: run.periodStart?.toISOString() ?? null,
    periodEnd: run.periodEnd?.toISOString() ?? null,
    sourceSha256: run.sourceSha256 ?? null,
    coverage: run.coverage ?? null,
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
