/**
 * FakaBridge refund + revoke + reconcile hooks.
 * Keep side-effects out of order state machine transactions where possible;
 * revoke is scheduled in-tx, executed async by worker/cron.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { logger } from '../logger.js'
import {
  callFakaOrderRevoke,
  callFakaOrderStatus,
  fakaRemoteOrderNoMatches,
  isFakaBridgeConfigured,
  type FakaBridgeClientOptions,
} from './client.js'
import { classifyFakaRemoteStatus } from './errors.js'
import { fakaReconcileTotal, fakaRevokeTotal } from '../metrics.js'
import { transitionOrderStatus } from '../../modules/orders/fulfillment.js'
import { releaseHeldOrder } from '../../modules/orders/accounting.js'
import { applyRefundInventoryPolicy } from '../../modules/orders/refundInventory.js'
import { config } from '../../config/index.js'
import { isLeaseExpiredUtc, readTaskScheduleUtc } from './scheduleUtc.js'

type Tx = Prisma.TransactionClient

const MAX_REVOKE_ATTEMPTS = 5

/** Shared with worker tests via __setFakaClientOverridesForTests. */
let testClientOverrides: FakaBridgeClientOptions | undefined

export function __setFakaLifecycleClientOverridesForTests(
  overrides?: FakaBridgeClientOptions
): void {
  testClientOverrides = overrides
}

function clientOverrides(): FakaBridgeClientOptions {
  return testClientOverrides ?? {}
}

function hasClientCredentials(): boolean {
  if (testClientOverrides?.url && testClientOverrides?.secret) return true
  return isFakaBridgeConfigured(clientOverrides())
}

/**
 * Call inside the same transaction that transitions an order to refunded.
 * Caller MUST already hold Order FOR UPDATE (lock order: Order → Task).
 *
 * Hard-cancel is only safe when the task has never been claimed (attempts === 0)
 * and has no active lease — lease alone is NOT proof of "never dispatched"
 * (clearLeaseKeepPending clears lease after intermediate/uncertain HTTP).
 *
 * - pending + attempts===0 + idle lease → hard cancel (never dispatched)
 * - pending + active lease → cancelRequested (HTTP may be in flight)
 * - pending + attempts>0 (lease idle) → needs_reconcile + cancelRequested
 * - needs_reconcile / succeeded / failed-with-trade → cancelRequested (+ revoke if opened)
 */
export async function onFakaOrderRefundedInTx(tx: Tx, orderId: number): Promise<void> {
  const task = await tx.fakaBridgeTask.findUnique({ where: { orderId } })
  if (!task) return

  const leaseExpired = await isLeaseExpiredUtc(tx, task.id)
  const inFlight = task.status === 'pending' && !leaseExpired
  // attempts is incremented at claim; any prior claim means remote may have been called
  // (even after clearLeaseKeepPending left lease empty).
  const mayHaveDispatched = task.attempts > 0

  if (task.status === 'pending') {
    if (inFlight) {
      await tx.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          cancelRequested: true,
          lastError: 'ORDER_REFUNDED',
          reconcileNote:
            'cancel_requested: refund while provision lease active; worker will revoke if opened',
        },
      })
      return
    }
    if (mayHaveDispatched) {
      // Intermediate/uncertain path cleared lease but HTTP may already have hit Xboard.
      await tx.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          status: 'needs_reconcile',
          cancelRequested: true,
          lastError: 'ORDER_REFUNDED',
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(),
          reconcileNote:
            'cancel_requested: refund after possible dispatch (attempts>0, lease idle); probe before terminal',
        },
      })
      return
    }
    await tx.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: 'cancelled',
        cancelRequested: true,
        completedAt: new Date(),
        lastError: 'ORDER_REFUNDED',
        leaseToken: null,
        leaseUntil: null,
        reconcileNote: 'cancelled: order refunded before any claim/dispatch',
      },
    })
    return
  }

  if (
    task.status === 'succeeded' ||
    task.status === 'needs_reconcile' ||
    (task.status === 'failed' && task.xboardTradeNo)
  ) {
    if (task.revokeStatus === 'succeeded' || task.revokeStatus === 'skipped') return
    // needs_reconcile may still be intermediate remotely — mark cancel + keep reconciling;
    // revoke only once we know remote opened (or already succeeded).
    if (task.status === 'needs_reconcile' && !task.xboardTradeNo) {
      await tx.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          cancelRequested: true,
          lastError: 'ORDER_REFUNDED',
          nextAttemptAt: new Date(),
          reconcileNote: 'cancel_requested: refund while needs_reconcile; probe before revoke',
        },
      })
      return
    }
    await tx.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        revokeStatus: 'pending',
        lastRevokeError: null,
        cancelRequested: true,
      },
    })
  }
}

/** Post-commit kick for pending revokes. */
export function scheduleFakaRevokeAttempt(taskId: number): void {
  if (config.nodeEnv === 'test') return
  setImmediate(() => {
    void processFakaRevokeTask(taskId).catch(err => {
      logger.error({ err, taskId, component: 'fakaBridge' }, 'FakaBridge revoke attempt failed')
    })
  })
}

export async function processFakaRevokeTask(taskId: number): Promise<'succeeded' | 'failed' | 'skipped'> {
  if (!hasClientCredentials()) {
    fakaRevokeTotal.inc({ outcome: 'skipped' })
    return 'skipped'
  }

  const now = new Date()
  const claimed = await prisma.$transaction(async tx => {
    const peek = await tx.fakaBridgeTask.findUnique({ where: { id: taskId } })
    if (!peek || peek.revokeStatus !== 'pending') return null
    const peekSched = await readTaskScheduleUtc(tx, taskId)
    if (!peekSched?.leaseExpired) return null
    // Order → Task lock order (matches refund path)
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${peek.orderId} FOR UPDATE`
    const task = await tx.fakaBridgeTask.findUnique({ where: { id: taskId } })
    if (!task || task.revokeStatus !== 'pending') return null
    const lockedSched = await readTaskScheduleUtc(tx, taskId)
    if (!lockedSched?.leaseExpired) return null
    const leaseToken = `revoke-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await tx.fakaBridgeTask.update({
      where: { id: taskId },
      data: {
        revokeAttempts: task.revokeAttempts + 1,
        leaseToken,
        leaseUntil: new Date(now.getTime() + config.fakaBridge.timeoutMs + 20_000),
      },
    })
    return {
      id: task.id,
      orderId: task.orderId,
      requestOrderNo: task.requestOrderNo,
      revokeAttempts: task.revokeAttempts + 1,
      leaseToken,
    }
  })

  if (!claimed) {
    fakaRevokeTotal.inc({ outcome: 'skipped' })
    return 'skipped'
  }

  const task = claimed
  const attempts = claimed.revokeAttempts

  const result = await callFakaOrderRevoke(
    task.requestOrderNo,
    `MoNexus order #${task.orderId} refunded`,
    clientOverrides()
  )

  if (result.ok && result.body && result.body.success === true) {
    // Must bind revoke response to this task's requestOrderNo — never mark succeeded on mismatch.
    if (!fakaRemoteOrderNoMatches(result.body, task.requestOrderNo)) {
      await prisma.fakaBridgeTask.updateMany({
        where: { id: taskId, leaseToken: claimed.leaseToken, revokeStatus: 'pending' },
        data: {
          lastRevokeError: 'FAKA_ORDER_NO_MISMATCH',
          leaseToken: null,
          leaseUntil: null,
          reconcileNote: `revoke response order_no missing/mismatch (expected ${task.requestOrderNo}); keep pending`,
        },
      })
      fakaRevokeTotal.inc({ outcome: 'failed' })
      logger.warn(
        { taskId, orderId: task.orderId, expected: task.requestOrderNo },
        'FakaBridge revoke order_no mismatch; retry later'
      )
      return 'failed'
    }
    await prisma.fakaBridgeTask.updateMany({
      where: { id: taskId, leaseToken: claimed.leaseToken, revokeStatus: 'pending' },
      data: {
        revokeStatus: 'succeeded',
        revokedAt: new Date(),
        lastRevokeError: null,
        leaseToken: null,
        leaseUntil: null,
        reconcileNote: result.body.expired_user
          ? 'revoke: xboard user expired'
          : 'revoke: marked revoked (user not expired or already inactive)',
      },
    })
    fakaRevokeTotal.inc({ outcome: 'succeeded' })
    logger.info(
      { taskId, orderId: task.orderId, expiredUser: result.body.expired_user },
      'FakaBridge revoke succeeded'
    )
    return 'succeeded'
  }

  // 404 "订单不存在" → nothing to revoke on Xboard (never provisioned / purged)
  const errText =
    result.body && typeof result.body === 'object' && 'error' in result.body
      ? String((result.body as { error?: string }).error ?? '')
      : result.code
  const notFound = result.httpStatus === 404 || /不存在/.test(errText)

  if (notFound || attempts >= MAX_REVOKE_ATTEMPTS) {
    await prisma.fakaBridgeTask.updateMany({
      where: { id: taskId, leaseToken: claimed.leaseToken, revokeStatus: 'pending' },
      data: {
        revokeStatus: notFound ? 'skipped' : 'failed',
        lastRevokeError: result.code,
        revokedAt: notFound ? new Date() : null,
        leaseToken: null,
        leaseUntil: null,
        reconcileNote: notFound
          ? 'revoke skipped: no faka_orders row on Xboard'
          : `revoke failed after ${attempts} attempts: ${result.code}`,
      },
    })
    fakaRevokeTotal.inc({ outcome: notFound ? 'skipped' : 'failed' })
    return notFound ? 'skipped' : 'failed'
  }

  await prisma.fakaBridgeTask.updateMany({
    where: { id: taskId, leaseToken: claimed.leaseToken, revokeStatus: 'pending' },
    data: { lastRevokeError: result.code, leaseToken: null, leaseUntil: null },
  })
  fakaRevokeTotal.inc({ outcome: 'failed' })
  return 'failed'
}

export async function runFakaRevokeBatch(limit = 10): Promise<number> {
  if (!hasClientCredentials()) return 0
  const due = await prisma.fakaBridgeTask.findMany({
    where: { revokeStatus: 'pending' },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true },
  })
  let n = 0
  for (const row of due) {
    const outcome = await processFakaRevokeTask(row.id)
    if (outcome !== 'skipped') n += 1
  }
  return n
}

export type StuckFakaTaskRow = {
  id: number
  orderId: number
  status: string
  requestOrderNo: string
  emailSnapshot: string
  xboardTradeNo: string | null
  attempts: number
  maxAttempts: number
}

type Queryable = {
  $queryRaw: typeof prisma.$queryRaw
}

/**
 * UTC-safe candidate selection for pending-order reconcile (same AT TIME ZONE
 * discipline as runFakaBridgeBatch). Accepts prisma or a TransactionClient so
 * tests can SET LOCAL TIME ZONE in the same connection/tx.
 */
export async function selectStuckFakaTasksForReconcile(
  db: Queryable,
  limit = 20,
  now: Date = new Date(),
  createdOlderThanMs = 120_000
): Promise<StuckFakaTaskRow[]> {
  const createdCutoff = new Date(now.getTime() - createdOlderThanMs)
  return db.$queryRaw<StuckFakaTaskRow[]>`
    SELECT
      t."id",
      t."orderId",
      t."status",
      t."requestOrderNo",
      t."emailSnapshot",
      t."xboardTradeNo",
      t."attempts",
      t."maxAttempts"
    FROM "FakaBridgeTask" t
    INNER JOIN "Order" o ON o."id" = t."orderId"
    WHERE t."status" IN ('pending', 'succeeded', 'needs_reconcile')
      AND o."status" = 'pending'
      AND (t."createdAt" AT TIME ZONE 'UTC') < ${createdCutoff}
      AND (t."nextAttemptAt" AT TIME ZONE 'UTC') <= ${now}
      AND (
        t."leaseUntil" IS NULL
        OR (t."leaseUntil" AT TIME ZONE 'UTC') <= ${now}
      )
    ORDER BY t."nextAttemptAt" ASC
    LIMIT ${limit}
  `
}

/**
 * Reconcile half-success states via order-status (unified classification):
 * - opened → deliver (order pending) or queue revoke (order refunded)
 * - not_opened → cancel task; if order still pending, refund + inventory
 * - intermediate / unknown → keep needs_reconcile, never hard-cancel
 */
export async function runFakaReconcileBatch(limit = 20): Promise<number> {
  if (!hasClientCredentials()) return 0
  let actions = 0

  // Refunded orders that still have open provision or missing revoke
  const refundedOrders = await prisma.order.findMany({
    where: {
      status: 'refunded',
      fakaBridgeTask: {
        OR: [
          { status: 'pending' },
          { status: 'needs_reconcile' },
          { status: 'succeeded', revokeStatus: null },
          { status: 'succeeded', revokeStatus: 'pending' },
          { status: 'failed', xboardTradeNo: { not: null }, revokeStatus: null },
          { status: 'failed', xboardTradeNo: { not: null }, revokeStatus: 'pending' },
          { cancelRequested: true, revokeStatus: null },
          { cancelRequested: true, revokeStatus: 'pending' },
        ],
      },
    },
    select: { id: true, fakaBridgeTask: { select: { id: true, status: true, revokeStatus: true } } },
    take: limit,
  })

  for (const order of refundedOrders) {
    const task = order.fakaBridgeTask
    if (!task) continue
    const full = await prisma.fakaBridgeTask.findUnique({ where: { id: task.id } })
    if (!full) continue
    const leaseExpired = await isLeaseExpiredUtc(prisma, full.id)
    const inFlight = full.status === 'pending' && !leaseExpired

    // Defer status probes until nextAttemptAt (UTC; 5‑minute park after intermediate).
    // Still process in-flight cancel_requested and pure revoke queue without waiting.
    if ((full.status === 'pending' || full.status === 'needs_reconcile') && !inFlight) {
      const sched = await readTaskScheduleUtc(prisma, full.id)
      if (sched && !sched.nextAttemptDue) continue
    }

    if (full.status === 'pending' && inFlight) {
      await prisma.fakaBridgeTask.update({
        where: { id: full.id },
        data: {
          cancelRequested: true,
          reconcileNote: 'reconcile: cancel_requested while lease active',
        },
      })
      fakaReconcileTotal.inc({ action: 'cancel_requested_inflight' })
      actions += 1
    } else if (
      (full.status === 'pending' || full.status === 'needs_reconcile') &&
      !inFlight
    ) {
      // Probe Xboard — intermediate remote (e.g. pending) must keep reconciling.
      const statusRes = await callFakaOrderStatus(full.requestOrderNo, clientOverrides())
      const xbBody =
        statusRes.ok && statusRes.body && statusRes.body.success === true
          ? statusRes.body
          : null
      if (xbBody && !fakaRemoteOrderNoMatches(xbBody, full.requestOrderNo)) {
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            status: 'needs_reconcile',
            cancelRequested: true,
            nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
            reconcileNote: `reconcile: status order_no mismatch (expected ${full.requestOrderNo})`,
          },
        })
        fakaReconcileTotal.inc({ action: 'refund_status_order_no_mismatch' })
        actions += 1
        continue
      }
      const xbStatus = xbBody ? String(xbBody.status ?? '') : ''
      const xbTrade = xbBody && xbBody.trade_no != null ? String(xbBody.trade_no) : null

      let remoteClass: ReturnType<typeof classifyFakaRemoteStatus> | 'not_opened' | 'unknown' =
        'unknown'
      if (statusRes.httpStatus === 404) {
        remoteClass = 'not_opened'
      } else if (xbBody) {
        remoteClass = classifyFakaRemoteStatus(xbStatus, xbTrade)
      }

      if (remoteClass === 'opened') {
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            status: 'succeeded',
            xboardTradeNo: xbTrade ?? full.xboardTradeNo,
            completedAt: full.completedAt ?? new Date(),
            lastError: null,
            leaseToken: null,
            leaseUntil: null,
            cancelRequested: true,
            revokeStatus: full.revokeStatus === 'succeeded' ? 'succeeded' : 'pending',
            lastRevokeError: null,
            reconcileNote: `reconcile: refunded but Xboard ${xbStatus}; queued revoke`,
          },
        })
        fakaReconcileTotal.inc({ action: 'queue_revoke_after_remote_open' })
        actions += 1
      } else if (remoteClass === 'not_opened') {
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            status: 'cancelled',
            cancelRequested: true,
            completedAt: new Date(),
            lastError: 'ORDER_REFUNDED',
            leaseToken: null,
            leaseUntil: null,
            revokeStatus: xbStatus === 'revoked' ? 'succeeded' : full.revokeStatus,
            revokedAt: xbStatus === 'revoked' ? new Date() : full.revokedAt,
            reconcileNote:
              xbStatus === 'revoked'
                ? 'reconcile: Xboard already revoked after refund'
                : statusRes.httpStatus === 404
                  ? 'reconcile: cancelled after refund (remote not found)'
                  : `reconcile: cancelled after refund (remote ${xbStatus || 'not_opened'})`,
          },
        })
        fakaReconcileTotal.inc({ action: 'cancel_after_refund' })
        actions += 1
      } else {
        // intermediate (pending / processing-no-trade) or probe unknown — keep parking
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            status: 'needs_reconcile',
            cancelRequested: true,
            leaseToken: null,
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
            reconcileNote:
              remoteClass === 'intermediate'
                ? `reconcile: refunded, remote intermediate (${xbStatus || 'empty'}); recheck`
                : 'reconcile: refunded, remote status unknown; recheck later',
          },
        })
        fakaReconcileTotal.inc({
          action:
            remoteClass === 'intermediate' ? 'refund_remote_intermediate' : 'refund_status_unknown',
        })
        actions += 1
      }
    } else if (
      (full.status === 'succeeded' ||
        (full.status === 'failed' && full.xboardTradeNo)) &&
      (full.revokeStatus == null || full.revokeStatus === '' || full.revokeStatus === 'pending')
    ) {
      if (full.revokeStatus !== 'pending') {
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            revokeStatus: 'pending',
            cancelRequested: true,
            reconcileNote: 'reconcile: queue revoke after refund',
          },
        })
        fakaReconcileTotal.inc({ action: 'queue_revoke' })
        actions += 1
      }
    }
  }

  // Stuck / needs_reconcile while MN order still pending (points held).
  const stuck = await selectStuckFakaTasksForReconcile(prisma, limit)

  for (const task of stuck) {
    // Belt-and-suspenders: re-check lease under UTC after selection.
    if (!(await isLeaseExpiredUtc(prisma, task.id))) continue

    if (task.status === 'succeeded') {
      const delivered = await tryDeliverPendingOrder(task.orderId, task.xboardTradeNo, task.emailSnapshot)
      if (delivered) {
        await prisma.fakaBridgeTask.update({
          where: { id: task.id },
          data: { reconcileNote: 'reconcile: delivered MN order after task succeeded' },
        })
        fakaReconcileTotal.inc({ action: 'deliver_after_success' })
        actions += 1
      }
      continue
    }

    const statusRes = await callFakaOrderStatus(task.requestOrderNo, clientOverrides())
    const xbBody =
      statusRes.ok && statusRes.body && statusRes.body.success === true ? statusRes.body : null
    if (xbBody && !fakaRemoteOrderNoMatches(xbBody, task.requestOrderNo)) {
      fakaReconcileTotal.inc({ action: 'status_order_no_mismatch' })
      continue
    }
    const xbStatus = xbBody ? String(xbBody.status ?? '') : ''
    const tradeNo = xbBody && xbBody.trade_no != null ? String(xbBody.trade_no) : null

    let remoteClass: ReturnType<typeof classifyFakaRemoteStatus> | 'not_opened' | 'unknown' =
      'unknown'
    if (statusRes.httpStatus === 404) {
      // Young pending may not have been attempted; needs_reconcile / exhausted → not_opened
      if (task.status === 'needs_reconcile' || task.attempts >= task.maxAttempts) {
        remoteClass = 'not_opened'
      } else {
        continue
      }
    } else if (xbBody) {
      remoteClass = classifyFakaRemoteStatus(xbStatus, tradeNo)
    } else {
      fakaReconcileTotal.inc({ action: 'status_probe_fail' })
      continue
    }

    if (remoteClass === 'opened') {
      const delivered = await tryDeliverPendingOrder(task.orderId, tradeNo, task.emailSnapshot)
      if (delivered) {
        await prisma.fakaBridgeTask.update({
          where: { id: task.id },
          data: {
            status: 'succeeded',
            xboardTradeNo: tradeNo,
            completedAt: new Date(),
            lastError: null,
            leaseToken: null,
            leaseUntil: null,
            reconcileNote: `reconcile: Xboard ${xbStatus} → MN delivered`,
          },
        })
        fakaReconcileTotal.inc({ action: 'deliver_from_xboard_status' })
        actions += 1
      } else {
        const order = await prisma.order.findUnique({
          where: { id: task.orderId },
          select: { status: true },
        })
        if (order?.status === 'refunded' || order?.status === 'closed') {
          await prisma.fakaBridgeTask.update({
            where: { id: task.id },
            data: {
              status: 'succeeded',
              xboardTradeNo: tradeNo,
              completedAt: new Date(),
              cancelRequested: true,
              revokeStatus: 'pending',
              leaseToken: null,
              leaseUntil: null,
              reconcileNote: `reconcile: Xboard ${xbStatus} but order ${order.status}; queued revoke`,
            },
          })
          fakaReconcileTotal.inc({ action: 'queue_revoke_from_stuck' })
          actions += 1
        }
      }
    } else if (remoteClass === 'not_opened') {
      // Definitive remote failure / absence → refund held points
      const refunded = await tryRefundPendingOrder(
        task.id,
        task.orderId,
        xbStatus || (statusRes.httpStatus === 404 ? 'not_found' : 'not_opened')
      )
      if (refunded) {
        fakaReconcileTotal.inc({ action: 'refund_from_remote_not_opened' })
        actions += 1
      }
    } else {
      // intermediate — park / refresh nextAttemptAt
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          status: 'needs_reconcile',
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
          reconcileNote: `reconcile: remote intermediate (${xbStatus || 'empty'}); recheck`,
        },
      })
      fakaReconcileTotal.inc({ action: 'park_intermediate' })
      actions += 1
    }
  }

  return actions
}

/** Refund a still-pending order when remote is definitively not opened. */
async function tryRefundPendingOrder(
  taskId: number,
  orderId: number,
  reason: string
): Promise<boolean> {
  try {
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
      const order = await tx.order.findUnique({
        where: { id: orderId },
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
      if (!order || order.status !== 'pending') return false

      await tx.fakaBridgeTask.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          lastError: `REMOTE_${reason}`.slice(0, 64),
          completedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
          cancelRequested: true,
          reconcileNote: `reconcile: remote ${reason} → refund held points`,
        },
      })

      await transitionOrderStatus(
        {
          orderId: order.id,
          toStatus: 'refunded',
          actorRole: 'system',
          action: 'system.faka_bridge.reconcile_refund',
          publicNote: '订阅开通失败，积分已退回',
          internalNote: `reconcile remote=${reason}`,
        },
        tx
      )
      await releaseHeldOrder(
        tx,
        order,
        `FakaBridge 对账开通失败退款: #${order.id} (${reason})`
      )
      await applyRefundInventoryPolicy(tx, order, {
        fromStatus: 'pending',
        actorUserId: order.userId,
      })
      return true
    })
  } catch (err) {
    logger.warn({ err, taskId, orderId }, 'FakaBridge reconcile refund failed')
    return false
  }
}

async function tryDeliverPendingOrder(
  orderId: number,
  tradeNo: string | null | undefined,
  email: string
): Promise<boolean> {
  try {
    return await prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true },
      })
      if (!order) return false
      if (order.status === 'delivered' || order.status === 'processing') {
        // Already progressed
        if (order.status === 'processing') {
          await transitionOrderStatus(
            {
              orderId,
              toStatus: 'delivered',
              actorRole: 'system',
              action: 'system.faka_bridge.reconcile_deliver',
              deliveryContent: deliveryContent(tradeNo ?? null, email),
              publicNote: 'Xboard 订阅已开通（对账收敛）',
              internalNote: tradeNo ? `trade_no=${tradeNo}; reconcile` : 'reconcile',
            },
            tx
          )
          return true
        }
        return false
      }
      if (order.status !== 'pending') {
        // refunded / closed etc. — do not deliver
        return false
      }

      await transitionOrderStatus(
        {
          orderId,
          toStatus: 'processing',
          actorRole: 'system',
          action: 'system.faka_bridge.reconcile_start',
          publicNote: '正在开通 Xboard 订阅（对账）',
        },
        tx
      )
      await transitionOrderStatus(
        {
          orderId,
          toStatus: 'delivered',
          actorRole: 'system',
          action: 'system.faka_bridge.reconcile_deliver',
          deliveryContent: deliveryContent(tradeNo ?? null, email),
          publicNote: 'Xboard 订阅已开通（对账收敛）',
          internalNote: tradeNo ? `trade_no=${tradeNo}; reconcile` : 'reconcile',
        },
        tx
      )
      return true
    })
  } catch (err) {
    logger.warn({ err, orderId }, 'FakaBridge reconcile deliver failed')
    return false
  }
}

function deliveryContent(tradeNo: string | null, email?: string | null): string {
  const panel = config.fakaBridge.panelUrl || 'https://v.uuwu.de'
  const no = tradeNo?.trim() || '(未知)'
  const mail = email?.trim() || '(开通邮箱见下单信息)'
  return [
    'Xboard 订阅已开通',
    `订单号: ${no}`,
    `开通邮箱: ${mail}`,
    `面板: ${panel}`,
    '请使用上述邮箱登录面板（已有账号直接登录；新账号请用「忘记密码」设置密码）。',
  ].join('\n')
}
