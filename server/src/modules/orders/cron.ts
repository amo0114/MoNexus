import { config } from '../../config/index.js'
import { notFound } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { transitionOrderStatus } from './fulfillment.js'

// PRD §4.3.1：delivered 超 7 天自动 closed，积分正式扣减并触发 Settlement
const AUTO_CLOSE_SLA_MS = 7 * 24 * 60 * 60 * 1000
const AUTO_CLOSE_INTERVAL_MS = 24 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let running = false

type AutoCloseCandidate = {
  id: number
  userId: number
  productId: number
  holdingPoints: number | null
}

async function findAutoCloseCandidates(): Promise<AutoCloseCandidate[]> {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_SLA_MS)
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
    },
  })
}

async function autoCloseOrder(order: AutoCloseCandidate): Promise<void> {
  try {
    const result = await prisma.$transaction(async tx => {
      const updated = await transitionOrderStatus(
        {
          orderId: order.id,
          toStatus: 'closed',
          actorRole: 'system',
          action: 'system.auto_close',
          publicNote: '系统自动关闭：超过 7 天未确认',
        },
        tx
      )

      if (order.holdingPoints != null && order.holdingPoints > 0) {
        const account = await tx.pointAccount.findUnique({ where: { userId: order.userId } })
        if (!account) throw notFound('积分账户不存在')
        const newBalance = account.balance - order.holdingPoints
        await tx.pointAccount.update({
          where: { userId: order.userId },
          data: { balance: newBalance },
        })
        await tx.pointLog.create({
          data: {
            userId: order.userId,
            type: 'out',
            amount: order.holdingPoints,
            balanceAfter: newBalance,
            reason: `系统自动关闭扣款: #${order.id}`,
            orderId: order.id,
          },
        })
        await tx.settlement.updateMany({
          where: { orderId: order.id, status: 'holding' },
          data: { status: 'pending' },
        })
      }

      await tx.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date() },
      })

      return updated
    })

    await invalidateProductPublicCache(result.productId, { list: 'coalesced' })
    logger.info({ orderId: order.id }, 'order auto-closed by system cron')
  } catch (err) {
    logger.warn({ err, orderId: order.id }, 'auto-close failed for order')
  }
}

async function runAutoCloseBatch() {
  if (running) return
  running = true
  try {
    const candidates = await findAutoCloseCandidates()
    if (candidates.length === 0) return
    logger.info({ count: candidates.length }, 'auto-close cron starting batch')
    for (const order of candidates) {
      await autoCloseOrder(order)
    }
  } catch (err) {
    logger.error({ err }, 'auto-close cron batch failed')
  } finally {
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

export async function __runAutoCloseBatchForTests() {
  await runAutoCloseBatch()
}
