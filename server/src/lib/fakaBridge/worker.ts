import { randomUUID } from 'node:crypto'
import { config } from '../../config/index.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { transitionOrderStatus } from '../../modules/orders/fulfillment.js'
import { releaseHeldOrder } from '../../modules/orders/accounting.js'
import {
  fakaProvisionTotal,
  fakaRevokePendingGauge,
  fakaTasksGauge,
} from '../metrics.js'
import {
  callFakaOrderPaid,
  callFakaOrderStatus,
  fakaRemoteOrderNoMatches,
  isFakaBridgeConfigured,
} from './client.js'
import { parseFakaExpiredAt } from './expiredAt.js'
import { buildFakaDeliveryPayload, subscriptionFromPaidBody } from './subscriptionResult.js'
import type { FakaSubscriptionResult } from './types.js'
import {
  classifyFakaRemoteStatus,
  FAKA_ERROR,
  isFakaNonRetryable,
  isFakaProvisionSuccessStatus,
  isFakaUncertainResult,
  type FakaErrorCode,
} from './errors.js'
import { applyRefundInventoryPolicy } from '../../modules/orders/refundInventory.js'
import type { FakaBridgeClientOptions } from './client.js'
import {
  runFakaReconcileBatch,
  runFakaRevokeBatch,
  __setFakaLifecycleClientOverridesForTests,
} from './lifecycle.js'
import { prewarmFakaCapacityForSkus } from './capacity.js'
import { readTaskScheduleUtc } from './scheduleUtc.js'

/** Lease covers HTTP timeout + result write headroom. */
const LEASE_MS = () => config.fakaBridge.timeoutMs + 20_000

/** Backoff seconds after the n-th failed attempt (attempt already incremented). */
const RETRY_DELAYS_SEC = [60, 300, 900]

const BATCH_LIMIT = 10

function panelUrl(): string {
  return config.fakaBridge.panelUrl || 'https://v.uuwu.de'
}

/** Test-only client overrides (inject mock transport / secret). */
let testClientOverrides: FakaBridgeClientOptions | undefined

/** Test-only: run after claim commit, before dispatch gate (simulate concurrent refund). */
let afterClaimHookForTests: (() => Promise<void>) | undefined

export function __setFakaClientOverridesForTests(overrides?: FakaBridgeClientOptions): void {
  testClientOverrides = overrides
  // Keep lifecycle (revoke/reconcile) on the same mock transport.
  __setFakaLifecycleClientOverridesForTests(overrides)
}

export function __setAfterClaimHookForTests(hook?: () => Promise<void>): void {
  afterClaimHookForTests = hook
}

function clientOverrides(): FakaBridgeClientOptions {
  return testClientOverrides ?? {}
}

function hasClientCredentials(): boolean {
  if (testClientOverrides?.url && testClientOverrides?.secret) return true
  return isFakaBridgeConfigured(clientOverrides())
}

function delaySecAfterAttempt(attempts: number): number {
  const idx = Math.min(Math.max(attempts, 1), RETRY_DELAYS_SEC.length) - 1
  return RETRY_DELAYS_SEC[idx] ?? RETRY_DELAYS_SEC[RETRY_DELAYS_SEC.length - 1]
}

function deliveryPayload(
  tradeNo: string | null,
  email?: string | null,
  subscription: FakaSubscriptionResult | null = null
) {
  return buildFakaDeliveryPayload({
    tradeNo,
    email,
    panelUrl: panelUrl(),
    subscription,
  })
}

export type ProcessOutcome = 'succeeded' | 'failed' | 'retry_scheduled' | 'skipped'

/**
 * Claim (if still pending/due), call Xboard, then deliver or schedule retry / refund.
 */
export async function processFakaBridgeTask(taskId: number): Promise<ProcessOutcome> {
  if (!hasClientCredentials()) {
    logger.warn({ taskId }, 'FakaBridge not configured; skip task')
    fakaProvisionTotal.inc({ outcome: 'skipped' })
    return 'skipped'
  }

  const now = new Date()
  const claimed = await prisma.$transaction(async tx => {
    // Lock Order first (same order as refund path: Order → Task) to avoid deadlocks.
    const peek = await tx.fakaBridgeTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        orderId: true,
        status: true,
        cancelRequested: true,
        attempts: true,
        maxAttempts: true,
        requestOrderNo: true,
        emailSnapshot: true,
        skuSnapshot: true,
        periodSnapshot: true,
      },
    })
    if (!peek || peek.status !== 'pending') return null
    if (peek.cancelRequested) return null

    const peekSched = await readTaskScheduleUtc(tx, taskId)
    if (!peekSched || !peekSched.nextAttemptDue || !peekSched.leaseExpired) return null

    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${peek.orderId} FOR UPDATE`

    // Re-read task + schedule under order lock (UTC re-check)
    const task = await tx.fakaBridgeTask.findUnique({ where: { id: taskId } })
    if (!task || task.status !== 'pending' || task.cancelRequested) return null
    const lockedSched = await readTaskScheduleUtc(tx, taskId)
    if (!lockedSched || !lockedSched.nextAttemptDue || !lockedSched.leaseExpired) return null

    const order = await tx.order.findUnique({
      where: { id: task.orderId },
      select: { status: true },
    })
    if (!order) return null
    if (order.status === 'refunded' || order.status === 'closed') {
      // attempts>0 ⇒ may have dispatched earlier; park for reconcile instead of hard cancel.
      if (task.attempts > 0) {
        await tx.fakaBridgeTask.update({
          where: { id: taskId },
          data: {
            status: 'needs_reconcile',
            cancelRequested: true,
            lastError: 'ORDER_REFUNDED',
            leaseToken: null,
            leaseUntil: null,
            nextAttemptAt: new Date(),
            reconcileNote: 'claim skipped: order terminal after prior attempts; probe remote',
          },
        })
      } else {
        await tx.fakaBridgeTask.update({
          where: { id: taskId },
          data: {
            status: 'cancelled',
            cancelRequested: true,
            completedAt: new Date(),
            lastError: 'ORDER_REFUNDED',
            leaseToken: null,
            leaseUntil: null,
            reconcileNote: 'claim skipped: order already terminal before any attempt',
          },
        })
      }
      return null
    }

    const attempts = task.attempts + 1
    const leaseToken = randomUUID()
    const nextAttemptAt = new Date(now.getTime() + delaySecAfterAttempt(attempts) * 1000)

    await tx.fakaBridgeTask.update({
      where: { id: taskId },
      data: {
        attempts,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS()),
        nextAttemptAt,
      },
    })

    return {
      id: task.id,
      orderId: task.orderId,
      requestOrderNo: task.requestOrderNo,
      emailSnapshot: task.emailSnapshot,
      skuSnapshot: task.skuSnapshot,
      periodSnapshot: task.periodSnapshot,
      maxAttempts: task.maxAttempts,
      attempts,
      leaseToken,
    }
  })

  if (!claimed) return 'skipped'

  if (afterClaimHookForTests) {
    await afterClaimHookForTests()
  }

  // Dispatch gate: re-lock Order → Task after claim commit, before any HTTP.
  // - Refund first → block outbound (cancel only if we still own the claim token).
  // - Must still hold a non-expired lease with our token; then renew lease for full HTTP.
  // - Stale worker after lease expiry must NOT pass (new worker may have re-claimed).
  const dispatchOk = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${claimed.orderId} FOR UPDATE`
    const order = await tx.order.findUnique({
      where: { id: claimed.orderId },
      select: { status: true },
    })
    const task = await tx.fakaBridgeTask.findUnique({ where: { id: claimed.id } })
    if (!order || !task) return false

    const stillOwnsClaim =
      task.status === 'pending' && task.leaseToken === claimed.leaseToken
    const sched = stillOwnsClaim ? await readTaskScheduleUtc(tx, claimed.id) : null
    const leaseStillActive = stillOwnsClaim && sched != null && !sched.leaseExpired

    if (
      !stillOwnsClaim ||
      !leaseStillActive ||
      task.cancelRequested ||
      order.status === 'refunded' ||
      order.status === 'closed'
    ) {
      // Only mutate if we still hold this claim token (avoid clobbering a new worker).
      if (stillOwnsClaim && (task.cancelRequested || order.status === 'refunded' || order.status === 'closed')) {
        // May have been claimed before (attempts already > 0) — park for reconcile if so.
        const hardCancel = task.attempts <= 0
        await tx.fakaBridgeTask.updateMany({
          where: {
            id: claimed.id,
            status: 'pending',
            leaseToken: claimed.leaseToken,
          },
          data: hardCancel
            ? {
                status: 'cancelled',
                cancelRequested: true,
                completedAt: new Date(),
                lastError: 'ORDER_REFUNDED',
                leaseToken: null,
                leaseUntil: null,
                reconcileNote: 'dispatch gate blocked: order refunded before first dispatch',
              }
            : {
                status: 'needs_reconcile',
                cancelRequested: true,
                lastError: 'ORDER_REFUNDED',
                leaseToken: null,
                leaseUntil: null,
                nextAttemptAt: new Date(),
                reconcileNote:
                  'dispatch gate blocked after prior attempts; park needs_reconcile for probe',
              },
        })
      }
      // Stale lease / token mismatch: leave row for the owner; zero outbound for us.
      return false
    }

    // Renew lease to cover the entire HTTP round-trip under our claim token.
    const renewedUntil = new Date(Date.now() + LEASE_MS())
    const renewed = await tx.fakaBridgeTask.updateMany({
      where: {
        id: claimed.id,
        status: 'pending',
        leaseToken: claimed.leaseToken,
      },
      data: { leaseUntil: renewedUntil },
    })
    return renewed.count === 1
  })

  if (!dispatchOk) {
    fakaProvisionTotal.inc({ outcome: 'skipped' })
    return 'skipped'
  }

  const paidAt = Math.floor(Date.now() / 1000)
  const result = await callFakaOrderPaid(
    {
      order_no: claimed.requestOrderNo,
      email: claimed.emailSnapshot,
      sku: claimed.skuSnapshot,
      period: claimed.periodSnapshot,
      paid_at: paidAt,
    },
    clientOverrides()
  )

  const bodyStatus =
    result.body && result.body.success === true && 'status' in result.body
      ? String((result.body as { status?: string }).status ?? '')
      : ''
  const tradeNoRaw =
    result.body && result.body.success === true && 'trade_no' in result.body
      ? (result.body as { trade_no?: string | null }).trade_no
      : null
  const tradeNo = tradeNoRaw != null ? String(tradeNoRaw) : null
  const paidSuccess =
    result.body && result.body.success === true ? result.body : null
  const remoteExpiredAt = paidSuccess
    ? parseFakaExpiredAt(paidSuccess.expired_at)
    : null
  const subscription = paidSuccess ? subscriptionFromPaidBody(paidSuccess) : null
  const provisionOk =
    result.ok &&
    result.body &&
    result.body.success === true &&
    isFakaProvisionSuccessStatus(bodyStatus, tradeNo)

  if (provisionOk) {
    // Must bind remote order_no to our requestOrderNo before deliver.
    // Missing/mismatch → park for status probe on the expected order no (do not deliver).
    const paidBody =
      result.body && result.body.success === true
        ? (result.body as { order_no?: string | null })
        : null
    if (!fakaRemoteOrderNoMatches(paidBody, claimed.requestOrderNo)) {
      await parkNeedsReconcile(
        claimed,
        FAKA_ERROR.UNKNOWN,
        `paid response order_no missing/mismatch (expected ${claimed.requestOrderNo}); reconcile via status`
      )
      fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
      return 'retry_scheduled'
    }
    return await finalizeProvisionSuccess(claimed, tradeNo, remoteExpiredAt, subscription)
  }

  // Paid returned success body but intermediate remote status (pending /
  // processing without trade_no) — never treat as definitive failure.
  if (result.ok && result.body && result.body.success === true) {
    const remoteClass = classifyFakaRemoteStatus(bodyStatus, tradeNo)
    if (remoteClass === 'intermediate') {
      const exhaustedEarly =
        isFakaNonRetryable(result.code as FakaErrorCode, result.httpStatus) ||
        claimed.attempts >= claimed.maxAttempts
      if (exhaustedEarly) {
        await parkNeedsReconcile(
          claimed,
          result.code as FakaErrorCode,
          `remote intermediate status=${bodyStatus || '(empty)'} after ${claimed.attempts} attempts`
        )
        fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
        return 'retry_scheduled'
      }
      await clearLeaseKeepPending(claimed, result.code as FakaErrorCode)
      fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
      return 'retry_scheduled'
    }
  }

  // Uncertain transport/business response: probe order-status before giving up.
  const code = result.code as FakaErrorCode
  const nonRetryable = isFakaNonRetryable(code, result.httpStatus)
  const exhausted = nonRetryable || claimed.attempts >= claimed.maxAttempts

  if (exhausted && isFakaUncertainResult(code)) {
    const st = await callFakaOrderStatus(claimed.requestOrderNo, clientOverrides())
    if (st.ok && st.body && st.body.success === true) {
      if (!fakaRemoteOrderNoMatches(st.body, claimed.requestOrderNo)) {
        await parkNeedsReconcile(
          claimed,
          code,
          `status probe order_no missing/mismatch (expected ${claimed.requestOrderNo})`
        )
        fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
        return 'retry_scheduled'
      }
      const xbStatus = String(st.body.status ?? '')
      const xbTrade = st.body.trade_no != null ? String(st.body.trade_no) : null
      const remoteClass = classifyFakaRemoteStatus(xbStatus, xbTrade)
      if (remoteClass === 'opened') {
        return await finalizeProvisionSuccess(
          claimed,
          xbTrade,
          parseFakaExpiredAt(st.body.expired_at),
          subscriptionFromPaidBody(st.body)
        )
      }
      if (remoteClass === 'not_opened') {
        await markFailedAndRefund(claimed, code)
        fakaProvisionTotal.inc({ outcome: 'failed' })
        return 'failed'
      }
      // intermediate (pending / processing-no-trade) → park, do NOT refund
      await parkNeedsReconcile(
        claimed,
        code,
        `status probe intermediate (${xbStatus || 'empty'}) after ${claimed.attempts} attempts`
      )
      fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
      return 'retry_scheduled'
    }
    if (st.httpStatus === 404) {
      await markFailedAndRefund(claimed, code)
      fakaProvisionTotal.inc({ outcome: 'failed' })
      return 'failed'
    }
    // Probe failed / unknown — park for reconcile; do NOT refund yet.
    await parkNeedsReconcile(
      claimed,
      code,
      `uncertain after ${claimed.attempts} attempts (${code}); awaiting status`
    )
    fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
    return 'retry_scheduled'
  }

  if (exhausted) {
    // Definitive non-retryable / business failure only.
    await markFailedAndRefund(claimed, code)
    fakaProvisionTotal.inc({ outcome: 'failed' })
    return 'failed'
  }

  await clearLeaseKeepPending(claimed, code)

  logger.warn(
    {
      taskId: claimed.id,
      orderId: claimed.orderId,
      code,
      attempts: claimed.attempts,
      httpStatus: result.httpStatus,
    },
    'FakaBridge provision attempt failed; retry scheduled'
  )
  fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
  return 'retry_scheduled'
}

async function parkNeedsReconcile(
  claimed: { id: number; leaseToken: string },
  code: FakaErrorCode,
  note: string
): Promise<void> {
  await prisma.fakaBridgeTask.updateMany({
    where: {
      id: claimed.id,
      status: 'pending',
      leaseToken: claimed.leaseToken,
    },
    data: {
      status: 'needs_reconcile',
      lastError: code,
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
      reconcileNote: note,
    },
  })
}

async function clearLeaseKeepPending(
  claimed: { id: number; leaseToken: string },
  code: FakaErrorCode
): Promise<void> {
  await prisma.fakaBridgeTask.updateMany({
    where: {
      id: claimed.id,
      status: 'pending',
      leaseToken: claimed.leaseToken,
    },
    data: {
      lastError: code,
      leaseToken: null,
      leaseUntil: null,
    },
  })
}

type ClaimedTask = {
  id: number
  orderId: number
  requestOrderNo: string
  emailSnapshot: string
  skuSnapshot: string
  periodSnapshot: string
  maxAttempts: number
  attempts: number
  leaseToken: string
}

async function finalizeProvisionSuccess(
  claimed: ClaimedTask,
  tradeNo: string | null,
  /** Xboard ground-truth subscription end; null = fall back to validityDays projection */
  remoteExpiredAt: Date | null = null,
  subscription: FakaSubscriptionResult | null = null
): Promise<ProcessOutcome> {
  const delivery = deliveryPayload(tradeNo, claimed.emailSnapshot, subscription)
  try {
    await prisma.$transaction(async tx => {
      // Order → Task lock order
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${claimed.orderId} FOR UPDATE`

      const order = await tx.order.findUnique({
        where: { id: claimed.orderId },
        select: { id: true, status: true },
      })
      if (!order) return

      const task = await tx.fakaBridgeTask.findUnique({ where: { id: claimed.id } })
      if (!task) return

      // In-flight refund cancelled us or asked cancel — still mark opened + revoke.
      if (
        task.status === 'cancelled' ||
        task.cancelRequested ||
        order.status === 'refunded' ||
        order.status === 'closed'
      ) {
        await tx.fakaBridgeTask.update({
          where: { id: claimed.id },
          data: {
            status: 'succeeded',
            xboardTradeNo: tradeNo ?? task.xboardTradeNo,
            completedAt: new Date(),
            lastError: null,
            leaseToken: null,
            leaseUntil: null,
            cancelRequested: true,
            revokeStatus: 'pending',
            lastRevokeError: null,
            // A revoke must not inherit this claim's provision retry backoff.
            nextAttemptAt: new Date(),
            reconcileNote: `xboard opened after cancel/refund (order=${order.status}); queued revoke`,
          },
        })
        return
      }

      if (task.status !== 'pending' || task.leaseToken !== claimed.leaseToken) {
        logger.warn({ taskId: claimed.id }, 'FakaBridge success CAS missed (stale lease)')
        return
      }

      await tx.fakaBridgeTask.update({
        where: { id: claimed.id },
        data: {
          status: 'succeeded',
          xboardTradeNo: tradeNo,
          completedAt: new Date(),
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
        },
      })

      if (order.status === 'pending') {
        await transitionOrderStatus(
          {
            orderId: order.id,
            toStatus: 'processing',
            actorRole: 'system',
            action: 'system.faka_bridge.start',
            publicNote: '正在开通 Xboard 订阅',
          },
          tx
        )
      }

      const refreshed = await tx.order.findUnique({
        where: { id: claimed.orderId },
        select: { status: true },
      })
      if (refreshed?.status === 'processing') {
        const actionNote =
          subscription?.action === 'renew'
            ? 'Xboard 续费成功'
            : subscription?.action === 'reset_traffic'
              ? 'Xboard 流量重置成功'
              : subscription?.action === 'onetime'
                ? 'Xboard 流量包已开通'
                : subscription?.action === 'new'
                  ? 'Xboard 新购开通成功'
                  : 'Xboard 订阅已开通'
        await transitionOrderStatus(
          {
            orderId: claimed.orderId,
            toStatus: 'delivered',
            actorRole: 'system',
            action: 'system.faka_bridge.deliver',
            deliveryContent: delivery.content,
            deliveryStructuredContent: delivery.structuredContent,
            publicNote: actionNote,
            internalNote: tradeNo
              ? `trade_no=${tradeNo}; email=${claimed.emailSnapshot}${remoteExpiredAt ? `; xboard_expired_at=${remoteExpiredAt.toISOString()}` : ''}${subscription?.action ? `; action=${subscription.action}` : ''}`
              : `email=${claimed.emailSnapshot}${remoteExpiredAt ? `; xboard_expired_at=${remoteExpiredAt.toISOString()}` : ''}${subscription?.action ? `; action=${subscription.action}` : ''}`,
            ...(remoteExpiredAt ? { expiresAtOverride: remoteExpiredAt } : {}),
          },
          tx
        )
      }
    })
  } catch (err) {
    logger.error({ err, taskId: claimed.id }, 'FakaBridge success result write failed')
    fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
    return 'retry_scheduled'
  }

  logger.info(
    {
      taskId: claimed.id,
      orderId: claimed.orderId,
      tradeNo,
      remoteExpiredAt: remoteExpiredAt?.toISOString() ?? null,
    },
    'FakaBridge provision succeeded'
  )
  fakaProvisionTotal.inc({ outcome: 'succeeded' })
  return 'succeeded'
}

async function markFailedAndRefund(
  claimed: {
    id: number
    orderId: number
    leaseToken: string
  },
  code: FakaErrorCode
): Promise<void> {
  try {
    await prisma.$transaction(async tx => {
      // Order → Task
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${claimed.orderId} FOR UPDATE`

      const cas = await tx.fakaBridgeTask.updateMany({
        where: {
          id: claimed.id,
          status: 'pending',
          leaseToken: claimed.leaseToken,
        },
        data: {
          status: 'failed',
          lastError: code,
          completedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        },
      })
      if (cas.count !== 1) {
        // May have been cancel_requested mid-flight — leave for reconcile
        return
      }

      const order = await tx.order.findUnique({
        where: { id: claimed.orderId },
        select: {
          id: true,
          userId: true,
          status: true,
          holdingPoints: true,
          fundsHeld: true,
          productId: true,
          offerId: true,
          merchantId: true,
          deliveryModeSnapshot: true,
        },
      })
      if (!order) return

      if (order.status === 'pending') {
        await transitionOrderStatus(
          {
            orderId: order.id,
            toStatus: 'refunded',
            actorRole: 'system',
            action: 'system.faka_bridge.failed_refund',
            publicNote: '订阅开通失败，积分已退回',
            internalNote: code,
          },
          tx
        )
        await releaseHeldOrder(
          tx,
          order,
          `FakaBridge 开通失败退款: #${order.id} (${code})`
        )
        await applyRefundInventoryPolicy(tx, order, {
          fromStatus: 'pending',
          actorUserId: order.userId,
        })
      } else if (order.status === 'refunded' || order.status === 'closed') {
        // Already refunded — if remote might exist, queue revoke on reconcile
        await tx.fakaBridgeTask.update({
          where: { id: claimed.id },
          data: {
            cancelRequested: true,
            reconcileNote: `failed after order ${order.status}; probe revoke if needed`,
          },
        })
      } else {
        logger.error(
          { orderId: order.id, status: order.status, code },
          'FakaBridge failed while order not pending; manual review needed'
        )
      }
    })
  } catch (err) {
    logger.error({ err, taskId: claimed.id }, 'FakaBridge fail/refund write failed')
  }

  logger.warn(
    { taskId: claimed.id, orderId: claimed.orderId, code },
    'FakaBridge provision failed permanently'
  )
}

/**
 * Process up to BATCH_LIMIT due pending tasks (best-effort; multi-instance safe via row CAS).
 */
export async function runFakaBridgeBatch(): Promise<number> {
  if (!hasClientCredentials()) {
    return 0
  }

  let processed = 0
  for (let i = 0; i < BATCH_LIMIT; i++) {
    const now = new Date()
    const due = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "FakaBridgeTask"
      WHERE "status" = 'pending'
        AND ("nextAttemptAt" AT TIME ZONE 'UTC') <= ${now}
        AND ("leaseUntil" IS NULL OR ("leaseUntil" AT TIME ZONE 'UTC') <= ${now})
      ORDER BY "nextAttemptAt" ASC
      LIMIT 1`
    if (due.length === 0) break

    const outcome = await processFakaBridgeTask(due[0].id)
    if (outcome === 'skipped') {
      break
    }
    processed += 1
  }
  return processed
}

/**
 * Warm every SKU that is actually sellable on the storefront.  Capacity cache
 * is process-local by design, so each instance performs this lightweight
 * prewarm; fetchFakaCapacityForSku's TTL/inflight coalescing bounds the calls.
 */
export async function runFakaCapacityPrewarm(): Promise<number> {
  if (!hasClientCredentials()) return 0
  const offers = await prisma.offer.findMany({
    where: {
      status: 'active',
      externalIntegration: 'faka_bridge',
      externalSku: { not: null },
      product: { status: 'active' },
    },
    select: { externalSku: true },
  })
  return prewarmFakaCapacityForSkus(
    offers.flatMap(offer => (offer.externalSku ? [offer.externalSku] : []))
  )
}

// --- Cron lifecycle ---

const INTERVAL_MS = 30_000
let timer: NodeJS.Timeout | null = null
let running = false
let capacityPrewarmRunning = false

/**
 * Capacity warming is intentionally outside the fulfillment tick's critical
 * path: a slow third-party capacity endpoint must not delay retry/revoke work.
 * Keep at most one local sweep active; the capacity module additionally
 * coalesces individual SKU probes.
 */
function scheduleFakaCapacityPrewarm(): void {
  if (capacityPrewarmRunning) return
  capacityPrewarmRunning = true
  void runFakaCapacityPrewarm()
    .catch(err => {
      logger.warn({ err }, 'Faka capacity prewarm failed')
    })
    .finally(() => {
      capacityPrewarmRunning = false
    })
}

export function startFakaBridgeCron(): void {
  if (timer) return
  if (!config.fakaBridge.enabled && config.nodeEnv === 'production') {
    logger.info('FakaBridge cron not started (FAKA_BRIDGE_* unset)')
    return
  }
  timer = setInterval(() => {
    void tick()
  }, INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: INTERVAL_MS }, 'FakaBridge cron started')
}

export function stopFakaBridgeCron(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  logger.info('FakaBridge cron stopped')
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const n = await runFakaBridgeBatch()
    const revoked = await runFakaRevokeBatch()
    const reconciled = await runFakaReconcileBatch()
    scheduleFakaCapacityPrewarm()
    if (n > 0 || revoked > 0 || reconciled > 0) {
      logger.info(
        { provisioned: n, revoked, reconciled },
        'FakaBridge batch finished'
      )
    }
    await refreshFakaTaskGauges()
  } catch (err) {
    logger.error({ err }, 'FakaBridge batch failed')
  } finally {
    running = false
  }
}

async function refreshFakaTaskGauges(): Promise<void> {
  try {
    const groups = await prisma.fakaBridgeTask.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const known = new Set(['pending', 'succeeded', 'failed', 'cancelled', 'needs_reconcile'])
    for (const s of known) fakaTasksGauge.set({ status: s }, 0)
    for (const g of groups) {
      fakaTasksGauge.set({ status: g.status }, g._count._all)
    }
    const revokePending = await prisma.fakaBridgeTask.count({
      where: { revokeStatus: 'pending' },
    })
    fakaRevokePendingGauge.set(revokePending)
  } catch (err) {
    logger.warn({ err }, 'FakaBridge gauge refresh failed')
  }
}
