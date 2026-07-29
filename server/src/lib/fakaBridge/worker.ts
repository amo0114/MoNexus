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
import { callFakaOrderPaid, callFakaOrderStatus, isFakaBridgeConfigured } from './client.js'
import {
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

export function __setFakaClientOverridesForTests(overrides?: FakaBridgeClientOptions): void {
  testClientOverrides = overrides
  // Keep lifecycle (revoke/reconcile) on the same mock transport.
  __setFakaLifecycleClientOverridesForTests(overrides)
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

function deliveryContent(tradeNo: string | null, email?: string | null): string {
  const no = tradeNo?.trim() || '(未知)'
  const mail = email?.trim() || '(开通邮箱见下单信息)'
  return [
    'Xboard 订阅已开通',
    `订单号: ${no}`,
    `开通邮箱: ${mail}`,
    `面板: ${panelUrl()}`,
    '请使用上述邮箱登录面板（已有账号直接登录；新账号请用「忘记密码」设置密码）。',
  ].join('\n')
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
        nextAttemptAt: true,
        leaseUntil: true,
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
    if (peek.nextAttemptAt.getTime() > now.getTime()) return null
    if (peek.leaseUntil && peek.leaseUntil.getTime() > now.getTime()) return null

    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${peek.orderId} FOR UPDATE`

    // Re-read task under order lock
    const task = await tx.fakaBridgeTask.findUnique({ where: { id: taskId } })
    if (!task || task.status !== 'pending' || task.cancelRequested) return null
    if (task.leaseUntil && task.leaseUntil.getTime() > now.getTime()) return null

    const order = await tx.order.findUnique({
      where: { id: task.orderId },
      select: { status: true },
    })
    if (!order) return null
    if (order.status === 'refunded' || order.status === 'closed') {
      await tx.fakaBridgeTask.update({
        where: { id: taskId },
        data: {
          status: 'cancelled',
          cancelRequested: true,
          completedAt: new Date(),
          lastError: 'ORDER_REFUNDED',
          leaseToken: null,
          leaseUntil: null,
          reconcileNote: 'claim skipped: order already terminal',
        },
      })
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
  const provisionOk =
    result.ok &&
    result.body &&
    result.body.success === true &&
    isFakaProvisionSuccessStatus(bodyStatus, tradeNo)

  if (provisionOk) {
    return await finalizeProvisionSuccess(claimed, tradeNo)
  }

  // Uncertain response: probe order-status before giving up.
  const code = result.code as FakaErrorCode
  const nonRetryable = isFakaNonRetryable(code, result.httpStatus)
  let exhausted = nonRetryable || claimed.attempts >= claimed.maxAttempts

  if (exhausted && isFakaUncertainResult(code)) {
    const st = await callFakaOrderStatus(claimed.requestOrderNo, clientOverrides())
    if (st.ok && st.body && st.body.success === true) {
      const xbStatus = String(st.body.status ?? '')
      const xbTrade = st.body.trade_no != null ? String(st.body.trade_no) : null
      if (isFakaProvisionSuccessStatus(xbStatus, xbTrade)) {
        return await finalizeProvisionSuccess(claimed, xbTrade)
      }
      if (xbStatus === 'failed' || xbStatus === 'revoked') {
        await markFailedAndRefund(claimed, code)
        fakaProvisionTotal.inc({ outcome: 'failed' })
        return 'failed'
      }
    } else if (st.httpStatus === 404) {
      await markFailedAndRefund(claimed, code)
      fakaProvisionTotal.inc({ outcome: 'failed' })
      return 'failed'
    } else {
      // Still unknown — park for reconcile; do NOT refund yet.
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
          reconcileNote: `uncertain after ${claimed.attempts} attempts (${code}); awaiting status`,
        },
      })
      fakaProvisionTotal.inc({ outcome: 'retry_scheduled' })
      return 'retry_scheduled'
    }
  }

  if (exhausted) {
    await markFailedAndRefund(claimed, code)
    fakaProvisionTotal.inc({ outcome: 'failed' })
    return 'failed'
  }

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
  tradeNo: string | null
): Promise<ProcessOutcome> {
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
        await transitionOrderStatus(
          {
            orderId: claimed.orderId,
            toStatus: 'delivered',
            actorRole: 'system',
            action: 'system.faka_bridge.deliver',
            deliveryContent: deliveryContent(tradeNo, claimed.emailSnapshot),
            publicNote: 'Xboard 订阅已开通',
            internalNote: tradeNo
              ? `trade_no=${tradeNo}; email=${claimed.emailSnapshot}`
              : `email=${claimed.emailSnapshot}`,
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
    { taskId: claimed.id, orderId: claimed.orderId, tradeNo },
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

// --- Cron lifecycle ---

const INTERVAL_MS = 30_000
let timer: NodeJS.Timeout | null = null
let running = false

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
