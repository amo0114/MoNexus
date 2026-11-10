import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { invalidateProductPublicCache } from '../../lib/productCatalog/publicCache.js'
import { transitionOrderStatus } from './fulfillment.js'
import { settleHeldOrder } from './accounting.js'
import { cleanupExpiredIdempotencyRecords } from './idempotency.js'
import { recordLifecycle } from './metrics.js'

// PRD §4.3.1：delivered 超过验收期限（交付时按 autoCloseDays 冻结，默认 7 天）自动 closed，积分正式扣减并触发 Settlement
const AUTO_CLOSE_INTERVAL_MS = 24 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let running = false

type AutoCloseCandidate = {
  id: number
  userId: number
  productId: number
  holdingPoints: number | null
  fundsHeld: boolean
}

// `cutoff` only serves orders delivered before acceptanceBy existed; newer
// orders carry the deadline frozen at delivery.
type AutoClosePolicy = { now: Date; cutoff: Date }

async function readAutoClosePolicy(): Promise<AutoClosePolicy> {
  const autoCloseDays = await getSystemConfigValue('autoCloseDays')
  const now = new Date()
  return { now, cutoff: new Date(now.getTime() - autoCloseDays * 24 * 60 * 60 * 1000) }
}

async function findAutoCloseCandidates({ now, cutoff }: AutoClosePolicy): Promise<AutoCloseCandidate[]> {
  return prisma.order.findMany({
    where: {
      status: { in: ['delivered', 'completed'] },
      OR: [
        { acceptanceBy: { lte: now } },
        { acceptanceBy: null, delivery: { deliveredAt: { lt: cutoff } } },
        { acceptanceBy: null, delivery: { deliveredAt: null, createdAt: { lt: cutoff } } },
      ],
    },
    select: {
      id: true,
      userId: true,
      productId: true,
      holdingPoints: true,
      fundsHeld: true,
    },
  })
}

async function autoCloseOrder(order: AutoCloseCandidate, policy: AutoClosePolicy): Promise<void> {
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`
      const currentOrder = await tx.order.findUnique({
        where: { id: order.id },
        select: {
          id: true,
          userId: true,
          productId: true,
          holdingPoints: true,
          fundsHeld: true,
          status: true,
          acceptanceBy: true,
          delivery: { select: { deliveredAt: true, createdAt: true } },
        },
      })
      if (!currentOrder || !['delivered', 'completed'].includes(currentOrder.status)) {
        return null
      }
      // The candidate query ran before the lock: a dispute → resume → redelivery
      // in between restarts the acceptance window, so re-check the deadline here.
      if (currentOrder.acceptanceBy) {
        if (currentOrder.acceptanceBy > policy.now) return null
      } else {
        const deliveredAt = currentOrder.delivery?.deliveredAt ?? currentOrder.delivery?.createdAt
        if (!deliveredAt || deliveredAt >= policy.cutoff) return null
      }

      const updated = await transitionOrderStatus(
        {
          orderId: currentOrder.id,
          toStatus: 'closed',
          actorRole: 'system',
          action: 'system.auto_close',
          publicNote: '系统自动关闭：超过验收期限未确认',
        },
        tx
      )

      await settleHeldOrder(tx, currentOrder, `系统自动关闭扣款: #${currentOrder.id}`)

      await tx.order.update({
        where: { id: currentOrder.id },
        data: { confirmedAt: new Date() },
      })

      return updated
    })

    if (!result) return
    recordLifecycle('auto_close', 'processed')

    await invalidateProductPublicCache(result.productId, { list: 'coalesced' })
    logger.info({ orderId: order.id }, 'order auto-closed by system cron')
  } catch (err) {
    recordLifecycle('auto_close', 'error')
    logger.warn({ err, orderId: order.id }, 'auto-close failed for order')
  }
}

export interface AutoCloseBatchHooks {
  afterCandidates?: (candidates: AutoCloseCandidate[]) => Promise<void> | void
}

async function runAutoCloseBatch(hooks?: AutoCloseBatchHooks) {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    // P7a：舰队租约——领不到说明本窗口已有实例执行，跳过本 tick（test 直通）。
    lease = await acquireCronLeaseWithHeartbeat('orderAutoClose', AUTO_CLOSE_INTERVAL_MS)
    if (!lease) return
    const cleaned = await cleanupExpiredIdempotencyRecords()
    if (cleaned > 0) logger.info({ count: cleaned }, 'expired idempotency records cleaned')

    const policy = await readAutoClosePolicy()
    const candidates = await findAutoCloseCandidates(policy)
    if (candidates.length === 0) return
    logger.info({ count: candidates.length }, 'auto-close cron starting batch')
    if (hooks?.afterCandidates) {
      await hooks.afterCandidates(candidates)
    }
    for (const order of candidates) {
      await autoCloseOrder(order, policy)
    }
  } catch (err) {
    recordLifecycle('auto_close', 'error')
    logger.error({ err }, 'auto-close cron batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startOrderCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return

  runAutoCloseBatch().catch(err => {
    logger.error({ err }, 'auto-close cron initial run failed')
  })
  timer = setInterval(() => {
    runAutoCloseBatch().catch(err => {
      logger.error({ err }, 'auto-close cron tick failed')
    })
  }, AUTO_CLOSE_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: AUTO_CLOSE_INTERVAL_MS }, 'order auto-close cron started')
}

export function stopOrderCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('order auto-close cron stopped')
}

export async function __runAutoCloseBatchForTests(hooks?: AutoCloseBatchHooks) {
  await runAutoCloseBatch(hooks)
}
