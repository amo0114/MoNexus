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
  isFakaBridgeConfigured,
  type FakaBridgeClientOptions,
} from './client.js'
import { fakaReconcileTotal, fakaRevokeTotal } from '../metrics.js'
import { transitionOrderStatus } from '../../modules/orders/fulfillment.js'
import { config } from '../../config/index.js'

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
 * - pending + idle lease → hard cancel (no HTTP yet / not in flight)
 * - pending + active lease → cancelRequested (worker finishes then revoke if opened)
 * - succeeded / needs_reconcile / failed-with-trade → queue revoke
 */
export async function onFakaOrderRefundedInTx(tx: Tx, orderId: number): Promise<void> {
  const task = await tx.fakaBridgeTask.findUnique({ where: { orderId } })
  if (!task) return

  const now = Date.now()
  const inFlight =
    task.status === 'pending' &&
    task.leaseUntil != null &&
    task.leaseUntil.getTime() > now

  if (task.status === 'pending') {
    if (inFlight) {
      await tx.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          cancelRequested: true,
          lastError: 'ORDER_REFUNDED',
          reconcileNote:
            'cancel_requested: refund while provision HTTP in flight; worker will revoke if opened',
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
        reconcileNote: 'cancelled: order refunded before provision completed',
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
    if (peek.leaseUntil && peek.leaseUntil.getTime() > now.getTime()) return null
    // Order → Task lock order (matches refund path)
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${peek.orderId} FOR UPDATE`
    const task = await tx.fakaBridgeTask.findUnique({ where: { id: taskId } })
    if (!task || task.revokeStatus !== 'pending') return null
    if (task.leaseUntil && task.leaseUntil.getTime() > now.getTime()) return null
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

/**
 * Reconcile half-success states via order-status:
 * 1) MN pending task but Xboard completed → deliver MN order
 * 2) MN succeeded but order still pending → deliver
 * 3) MN order refunded + task succeeded + no revoke → queue revoke
 * 4) MN order refunded + task still pending → cancel task
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
    const inFlight =
      full.status === 'pending' &&
      full.leaseUntil != null &&
      full.leaseUntil.getTime() > Date.now()
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
      // Must probe Xboard: remote may have opened while our response was lost.
      const statusRes = await callFakaOrderStatus(full.requestOrderNo, clientOverrides())
      const xbBody =
        statusRes.ok && statusRes.body && statusRes.body.success === true
          ? statusRes.body
          : null
      const xbStatus = xbBody ? String(xbBody.status ?? '') : ''
      const xbTrade = xbBody && xbBody.trade_no != null ? String(xbBody.trade_no) : null
      const remoteOpened =
        xbBody != null &&
        (xbStatus === 'completed' ||
          (xbStatus === 'processing' && xbTrade != null && xbTrade.trim() !== ''))

      if (remoteOpened) {
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
      } else if (
        statusRes.httpStatus === 404 ||
        xbStatus === 'failed' ||
        xbStatus === 'revoked' ||
        (xbBody != null && xbStatus === 'pending')
      ) {
        // Safe to cancel locally — remote never completed (or already gone).
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            status: xbStatus === 'revoked' ? 'cancelled' : 'cancelled',
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
                : 'reconcile: cancelled pending task after refund (remote not opened)',
          },
        })
        fakaReconcileTotal.inc({ action: 'cancel_after_refund' })
        actions += 1
      } else {
        // Probe failed / unknown — park for next tick; do not hard-cancel.
        await prisma.fakaBridgeTask.update({
          where: { id: full.id },
          data: {
            status: 'needs_reconcile',
            cancelRequested: true,
            leaseToken: null,
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
            reconcileNote: 'reconcile: refunded, remote status unknown; recheck later',
          },
        })
        fakaReconcileTotal.inc({ action: 'refund_status_unknown' })
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

  // Stuck: task succeeded (or Xboard completed) but MN order still pending
  const stuck = await prisma.fakaBridgeTask.findMany({
    where: {
      status: { in: ['pending', 'succeeded', 'needs_reconcile'] },
      order: { status: 'pending' },
      // Older than 2 minutes — give first-attempt/worker a chance
      createdAt: { lt: new Date(Date.now() - 120_000) },
    },
    take: limit,
    select: {
      id: true,
      orderId: true,
      status: true,
      requestOrderNo: true,
      emailSnapshot: true,
      xboardTradeNo: true,
      leaseUntil: true,
    },
  })

  for (const task of stuck) {
    // Don't steal active leases
    if (task.leaseUntil && task.leaseUntil.getTime() > Date.now()) continue

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

    // pending: ask Xboard
    const statusRes = await callFakaOrderStatus(task.requestOrderNo, clientOverrides())
    if (!statusRes.ok || !statusRes.body || statusRes.body.success !== true) {
      if (statusRes.httpStatus === 404) {
        // No row yet — normal for not-yet-attempted; skip
        continue
      }
      fakaReconcileTotal.inc({ action: 'status_probe_fail' })
      continue
    }

    const xb = statusRes.body
    const tradeNo = xb.trade_no != null ? String(xb.trade_no) : null
    const remoteOk =
      xb.status === 'completed' ||
      (xb.status === 'processing' && tradeNo != null && tradeNo.trim() !== '')
    if (remoteOk) {
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
            reconcileNote: `reconcile: Xboard ${xb.status} → MN delivered`,
          },
        })
        fakaReconcileTotal.inc({ action: 'deliver_from_xboard_status' })
        actions += 1
      } else {
        // Order may already be refunded — mark opened so revoke path can run.
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
              reconcileNote: `reconcile: Xboard ${xb.status} but order ${order.status}; queued revoke`,
            },
          })
          fakaReconcileTotal.inc({ action: 'queue_revoke_from_stuck' })
          actions += 1
        }
      }
    } else if (xb.status === 'revoked') {
      // Xboard already revoked; ensure we don't keep opening
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          status: task.status === 'pending' ? 'cancelled' : task.status,
          revokeStatus: 'succeeded',
          revokedAt: new Date(),
          reconcileNote: 'reconcile: Xboard already revoked',
        },
      })
      fakaReconcileTotal.inc({ action: 'sync_revoked' })
      actions += 1
    }
  }

  return actions
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
