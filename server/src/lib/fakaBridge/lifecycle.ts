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
 * - pending provision → cancel task (do not open after refund)
 * - succeeded provision → queue Xboard revoke
 */
export async function onFakaOrderRefundedInTx(tx: Tx, orderId: number): Promise<void> {
  const task = await tx.fakaBridgeTask.findUnique({ where: { orderId } })
  if (!task) return

  if (task.status === 'pending') {
    await tx.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
        lastError: 'ORDER_REFUNDED',
        leaseToken: null,
        leaseUntil: null,
        reconcileNote: 'cancelled: order refunded before provision completed',
      },
    })
    return
  }

  if (task.status === 'succeeded') {
    if (task.revokeStatus === 'succeeded' || task.revokeStatus === 'skipped') return
    await tx.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        revokeStatus: 'pending',
        lastRevokeError: null,
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

  const task = await prisma.fakaBridgeTask.findUnique({ where: { id: taskId } })
  if (!task || task.revokeStatus !== 'pending') {
    fakaRevokeTotal.inc({ outcome: 'skipped' })
    return 'skipped'
  }

  const attempts = task.revokeAttempts + 1
  await prisma.fakaBridgeTask.update({
    where: { id: taskId },
    data: { revokeAttempts: attempts },
  })

  const result = await callFakaOrderRevoke(
    task.requestOrderNo,
    `MoNexus order #${task.orderId} refunded`,
    clientOverrides()
  )

  if (result.ok && result.body && result.body.success === true) {
    await prisma.fakaBridgeTask.update({
      where: { id: taskId },
      data: {
        revokeStatus: 'succeeded',
        revokedAt: new Date(),
        lastRevokeError: null,
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
    await prisma.fakaBridgeTask.update({
      where: { id: taskId },
      data: {
        revokeStatus: notFound ? 'skipped' : 'failed',
        lastRevokeError: result.code,
        revokedAt: notFound ? new Date() : null,
        reconcileNote: notFound
          ? 'revoke skipped: no faka_orders row on Xboard'
          : `revoke failed after ${attempts} attempts: ${result.code}`,
      },
    })
    fakaRevokeTotal.inc({ outcome: notFound ? 'skipped' : 'failed' })
    return notFound ? 'skipped' : 'failed'
  }

  await prisma.fakaBridgeTask.update({
    where: { id: taskId },
    data: { lastRevokeError: result.code },
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
          { status: 'succeeded', revokeStatus: null },
          { status: 'succeeded', revokeStatus: 'pending' },
        ],
      },
    },
    select: { id: true, fakaBridgeTask: { select: { id: true, status: true, revokeStatus: true } } },
    take: limit,
  })

  for (const order of refundedOrders) {
    const task = order.fakaBridgeTask
    if (!task) continue
    if (task.status === 'pending') {
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          lastError: 'ORDER_REFUNDED',
          leaseToken: null,
          leaseUntil: null,
          reconcileNote: 'reconcile: cancelled pending task after refund',
        },
      })
      fakaReconcileTotal.inc({ action: 'cancel_after_refund' })
      actions += 1
    } else if (task.status === 'succeeded' && (task.revokeStatus == null || task.revokeStatus === '')) {
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: { revokeStatus: 'pending', reconcileNote: 'reconcile: queue revoke after refund' },
      })
      fakaReconcileTotal.inc({ action: 'queue_revoke' })
      actions += 1
    }
  }

  // Stuck: task succeeded (or Xboard completed) but MN order still pending
  const stuck = await prisma.fakaBridgeTask.findMany({
    where: {
      status: { in: ['pending', 'succeeded'] },
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
    if (xb.status === 'completed' || (xb.status === 'processing' && xb.trade_no)) {
      const tradeNo = xb.trade_no ? String(xb.trade_no) : null
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
