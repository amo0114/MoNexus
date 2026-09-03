import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { transitionOrderStatus } from './fulfillment.js'
import { settleHeldOrder } from './accounting.js'
import { cleanupExpiredIdempotencyRecords } from './idempotency.js'

// PRD §4.3.1：delivered 超 7 天自动 closed，积分正式扣减并触发 Settlement
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

async function findAutoCloseCandidates(): Promise<AutoCloseCandidate[]> {
  // P6a：每轮巡检读取配置（lowStockNotify 范式），管理端改天数即时生效。
  const autoCloseDays = await getSystemConfigValue('autoCloseDays')
  const cutoff = new Date(Date.now() - autoCloseDays * 24 * 60 * 60 * 1000)
  return prisma.order.findMany({
    where: {
      status: { in: ['delivered', 'completed'] },
      OR: [
        { delivery: { deliveredAt: { lt: cutoff } } },
        { delivery: { deliveredAt: null, createdAt: { lt: cutoff } } },
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

async function autoCloseOrder(order: AutoCloseCandidate): Promise<void> {
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
        },
      })
      if (!currentOrder || !['delivered', 'completed'].includes(currentOrder.status)) {
        return null
      }

      const updated = await transitionOrderStatus(
        {
          orderId: currentOrder.id,
          toStatus: 'closed',
          actorRole: 'system',
          action: 'system.auto_close',
          publicNote: '系统自动关闭：超过 7 天未确认',
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

    await invalidateProductPublicCache(result.productId, { list: 'coalesced' })
    logger.info({ orderId: order.id }, 'order auto-closed by system cron')
  } catch (err) {
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

    const candidates = await findAutoCloseCandidates()
    if (candidates.length === 0) return
    logger.info({ count: candidates.length }, 'auto-close cron starting batch')
    if (hooks?.afterCandidates) {
      await hooks.afterCandidates(candidates)
    }
    for (const order of candidates) {
      await autoCloseOrder(order)
    }
  } catch (err) {
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
