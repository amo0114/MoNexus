import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'

/**
 * SPEC-ORDER-NOTIFY D-05：通知过期自动归档。
 *
 * dispatcher 写入的 `expiresAt` 到期后，本任务把行置为 `archived`
 * （**不物理删除**——消息中心保留 `status=archived` 的显式历史查询能力）。
 * 读取侧（unread-count / 默认列表 / markAllAsRead）同步按 `expiresAt`
 * 排除逻辑过期行，因此计数正确性不依赖本 cron 的执行及时性；cron 只是
 * 让存储状态最终与逻辑口径一致。
 *
 * 幂等：只碰「已到期且尚未 archived」的行，updateMany 重复执行零副作用。
 * 舰队租约：多实例部署时同一窗口只允许一个执行者（test 环境直通）。
 */

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000 // 每小时一轮

let timer: NodeJS.Timeout | null = null
let running = false

async function runExpiryBatch() {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('notificationExpiry', EXPIRY_INTERVAL_MS)
    if (!lease) return

    const result = await prisma.notification.updateMany({
      where: { expiresAt: { lte: new Date() }, status: { not: 'archived' } },
      data: { status: 'archived' },
    })

    if (result.count > 0) {
      logger.info({ notificationsArchived: result.count }, 'expired notifications archived')
    }
  } catch (err) {
    logger.error({ err }, 'notification expiry batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startNotificationExpiryCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return

  runExpiryBatch().catch(err => {
    logger.error({ err }, 'notification expiry cron initial run failed')
  })
  timer = setInterval(() => {
    runExpiryBatch().catch(err => {
      logger.error({ err }, 'notification expiry cron tick failed')
    })
  }, EXPIRY_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: EXPIRY_INTERVAL_MS }, 'notification expiry cron started')
}

export function stopNotificationExpiryCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('notification expiry cron stopped')
}

export async function __runNotificationExpiryBatchForTests() {
  await runExpiryBatch()
}
