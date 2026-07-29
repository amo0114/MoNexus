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
import { callFakaOrderPaid, isFakaBridgeConfigured } from './client.js'
import { isFakaNonRetryable, type FakaErrorCode } from './errors.js'
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
    // TIMESTAMP WITHOUT TIME ZONE: compare via UTC reinterpretation (same trap as
    // provisionCron / P6 booking). Do not trust Prisma Date wall-clock compares.
    const due = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "FakaBridgeTask"
      WHERE "id" = ${taskId}
        AND "status" = 'pending'
        AND ("nextAttemptAt" AT TIME ZONE 'UTC') <= ${now}
        AND ("leaseUntil" IS NULL OR ("leaseUntil" AT TIME ZONE 'UTC') <= ${now})
      FOR UPDATE`

    if (due.length === 0) return null

    const task = await tx.fakaBridgeTask.findUnique({ where: { id: taskId } })
    if (!task || task.status !== 'pending') return null

    const attempts = task.attempts + 1
    const leaseToken = randomUUID()
    const nextAttemptAt = new Date(now.getTime() + delaySecAfterAttempt(attempts) * 1000)

    await tx.fakaBridgeTask.update({
      where: { id: taskId },
      data: {
        attempts,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS()),
        // Pre-write backoff so a crash mid-HTTP does not tight-loop
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

  // Only treat completed (or processing with trade_no) as provision success —
  // never "success" for revoked / failed status payloads.
  const bodyStatus =
    result.body && result.body.success === true && 'status' in result.body
      ? String(result.body.status)
      : ''
  const provisionOk =
    result.ok &&
    result.body &&
    result.body.success === true &&
    bodyStatus !== 'revoked' &&
    bodyStatus !== 'failed'

  if (provisionOk) {
    const tradeNo =
      'trade_no' in result.body! && result.body!.trade_no != null
        ? String(result.body!.trade_no)
        : null

    try {
      await prisma.$transaction(async tx => {
        const cas = await tx.fakaBridgeTask.updateMany({
          where: {
            id: claimed.id,
            status: 'pending',
            leaseToken: claimed.leaseToken,
          },
          data: {
            status: 'succeeded',
            xboardTradeNo: tradeNo,
            completedAt: new Date(),
            lastError: null,
            leaseToken: null,
            leaseUntil: null,
          },
        })
        if (cas.count !== 1) {
          logger.warn({ taskId: claimed.id }, 'FakaBridge success CAS missed (stale lease)')
          return
        }

        const order = await tx.order.findUnique({
          where: { id: claimed.orderId },
          select: { id: true, status: true },
        })
        if (!order) return

        // Race: order already refunded while Xboard opened → mark revoke pending, do not deliver.
        if (order.status === 'refunded' || order.status === 'closed') {
          await tx.fakaBridgeTask.update({
            where: { id: claimed.id },
            data: {
              revokeStatus: 'pending',
              reconcileNote: `provision ok but order ${order.status}; queued revoke`,
            },
          })
          return
        }

        // pending → processing → delivered (state machine forbids direct pending→delivered)
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
      // Leave lease to expire; next claim can re-call (Xboard is idempotent on order_no)
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

  const code = result.code as FakaErrorCode
  const nonRetryable = isFakaNonRetryable(code, result.httpStatus)
  const exhausted = nonRetryable || claimed.attempts >= claimed.maxAttempts

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
      // nextAttemptAt already advanced at claim time
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
      if (cas.count !== 1) return

      const order = await tx.order.findUnique({
        where: { id: claimed.orderId },
        select: {
          id: true,
          userId: true,
          status: true,
          holdingPoints: true,
          fundsHeld: true,
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
    const known = new Set(['pending', 'succeeded', 'failed', 'cancelled'])
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
