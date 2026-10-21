import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { isFakaBridgeConfigured, isLeaseExpiredUtc } from '../../lib/fakaBridge/index.js'
import { syncFakaExpiresAtFromRemote, processFakaBridgeTask, processFakaRevokeTask } from '../fakaBridge/service.js'

// ---- FakaBridge task ops (admin MFA) ----

export async function listFakaBridgeTasks(query: {
  status?: string
  revokeStatus?: string
  page?: number
  pageSize?: number
}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.FakaBridgeTaskWhereInput = {}
  if (query.status) where.status = query.status
  if (query.revokeStatus) where.revokeStatus = query.revokeStatus

  const [total, items] = await Promise.all([
    prisma.fakaBridgeTask.count({ where }),
    prisma.fakaBridgeTask.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        order: {
          select: {
            id: true,
            status: true,
            price: true,
            productNameSnapshot: true,
            user: { select: { id: true, email: true } },
          },
        },
      },
    }),
  ])

  return {
    items: items.map(t => ({
      id: t.id,
      orderId: t.orderId,
      status: t.status,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      lastError: t.lastError,
      xboardTradeNo: t.xboardTradeNo,
      requestOrderNo: t.requestOrderNo,
      emailSnapshot: t.emailSnapshot,
      skuSnapshot: t.skuSnapshot,
      periodSnapshot: t.periodSnapshot,
      revokeStatus: t.revokeStatus,
      revokeAttempts: t.revokeAttempts,
      revokedAt: t.revokedAt,
      lastRevokeError: t.lastRevokeError,
      reconcileNote: t.reconcileNote,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      nextAttemptAt: t.nextAttemptAt,
      order: t.order,
    })),
    total,
    page,
    pageSize,
  }
}

export async function getFakaBridgeTaskStats() {
  const byStatus = await prisma.fakaBridgeTask.groupBy({
    by: ['status'],
    _count: { _all: true },
  })
  const byRevoke = await prisma.fakaBridgeTask.groupBy({
    by: ['revokeStatus'],
    _count: { _all: true },
  })
  return {
    byStatus: Object.fromEntries(byStatus.map(g => [g.status, g._count._all])),
    byRevoke: Object.fromEntries(
      byRevoke.map(g => [g.revokeStatus ?? 'null', g._count._all])
    ),
    configured: isFakaBridgeConfigured(),
  }
}

/** Admin: re-queue a failed/cancelled provision for another attempt. */
export async function retryFakaBridgeTask(adminUserId: number, taskId: number) {
  const task = await prisma.fakaBridgeTask.findUnique({
    where: { id: taskId },
    include: { order: { select: { id: true, status: true } } },
  })
  if (!task) throw notFound('FakaBridge 任务不存在')
  // Already opened: re-sync DeliveryRecord.expiresAt from Xboard (display drift repair).
  if (task.status === 'succeeded' && task.order.status === 'delivered') {
    let sync: Awaited<ReturnType<typeof syncFakaExpiresAtFromRemote>>
    try {
      sync = await syncFakaExpiresAtFromRemote(taskId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw badRequest(msg.includes('not configured') ? 'FakaBridge 未配置' : msg)
    }
    await prisma.adminLog.create({
      data: {
        adminUserId,
        action: '同步Faka订阅到期',
        targetType: 'faka_bridge_task',
        targetId: taskId,
        detail: `orderId=${task.orderId}; aligned=${sync.aligned}; ${sync.previousExpiresAt ?? 'null'} → ${sync.expiresAt ?? 'null'}; ${sync.message}`,
      },
    })
    return {
      id: taskId,
      status: task.status,
      outcome: sync.aligned ? 'expires_aligned' : 'expires_unchanged',
      ...sync,
    }
  }
  if (task.order.status === 'refunded' || task.order.status === 'closed') {
    throw badRequest('订单已退款/关闭，请走撤销而非重试开通')
  }

  if (!(await isLeaseExpiredUtc(prisma, taskId))) {
    throw badRequest('任务正在处理中（租约未过期），请稍后再重试')
  }
  if (task.cancelRequested) {
    throw badRequest('任务已标记取消/退款，请走撤销而非重试开通')
  }

  await prisma.fakaBridgeTask.update({
    where: { id: taskId },
    data: {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      // Do not clear an active lease (already gated above).
      lastError: null,
      completedAt: null,
      cancelRequested: false,
      reconcileNote: `admin retry by user ${adminUserId}`,
    },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '重试Faka开通',
      targetType: 'faka_bridge_task',
      targetId: taskId,
      detail: `orderId=${task.orderId}`,
    },
  })

  // Fire immediately (outside test skip inside schedule helper — call worker)
  if (config.nodeEnv !== 'test') {
    setImmediate(() => {
      void processFakaBridgeTask(taskId).catch(() => undefined)
    })
  }

  return { ok: true, taskId, status: 'pending' }
}

/** Admin: force queue / re-run Xboard revoke for a succeeded provision. */
export async function forceFakaBridgeRevoke(adminUserId: number, taskId: number) {
  const task = await prisma.fakaBridgeTask.findUnique({ where: { id: taskId } })
  if (!task) throw notFound('FakaBridge 任务不存在')
  const allowed =
    task.status === 'succeeded' ||
    task.status === 'needs_reconcile' ||
    (task.status === 'failed' && Boolean(task.xboardTradeNo)) ||
    task.cancelRequested
  if (!allowed) {
    throw badRequest('仅已开通/可能已开通的任务可强制撤销（succeeded / needs_reconcile / failed+trade_no）')
  }
  if (task.revokeStatus === 'succeeded') {
    throw badRequest('任务已撤销成功')
  }
  if (!(await isLeaseExpiredUtc(prisma, taskId))) {
    throw badRequest('任务租约未过期，请稍后再强制撤销')
  }

  await prisma.fakaBridgeTask.update({
    where: { id: taskId },
    data: {
      revokeStatus: 'pending',
      lastRevokeError: null,
      // Override any provision/revoke cooldown: this endpoint is explicitly a force retry.
      nextAttemptAt: new Date(),
      cancelRequested: true,
      reconcileNote: `admin force revoke by user ${adminUserId}`,
    },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '强制撤销Xboard订阅',
      targetType: 'faka_bridge_task',
      targetId: taskId,
      detail: `orderId=${task.orderId}; requestOrderNo=${task.requestOrderNo}`,
    },
  })

  const outcome = await processFakaRevokeTask(taskId)
  return { ok: true, taskId, outcome }
}
