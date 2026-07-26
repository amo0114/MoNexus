import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'
import { getDeliveryStorage } from './storage/delivery.js'

/**
 * P5 T6：交付文件生命周期清理（设计 §8）。
 *
 * 硬规则：
 * - DeliveryFile / FileGrantLog 行**永不物理删除**——清理只把行标记为
 *   deleted + deletedAt，保持审计外键完整。
 * - 对象删除按 key 引用计数：内容寻址键可能被多行共享（不同商家上传同
 *   内容），仅当"没有任何其他 active/revoked 行引用同 key"时才删对象。
 * - 删除幂等：对象不存在时 delete 静默成功，失败行下轮重试。
 *
 * 清理场景：
 * 1. 孤儿上传：24h 内未被任何 Offer.fixedFileId / DeliveryRecord.fileId
 *    引用 → 标记 deleted + 条件删对象。
 * 2. tmp/ 遗留：流式上传中断残留的临时对象（无行，纯对象清理），超 24h 删。
 * 3. 退款保留期：被订单引用但所有相关订单都已退款超过 90 天，且无在售
 *    规格引用 → 标记 deleted + 条件删对象（固定文件与人工附件一视同仁）。
 */

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
const REFUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

/** 无任何其他非 deleted 行引用同 key 时才允许删对象。 */
async function canDeleteObject(key: string, excludeFileId: number): Promise<boolean> {
  const sibling = await prisma.deliveryFile.findFirst({
    where: { key, status: { not: 'deleted' }, id: { not: excludeFileId } },
    select: { id: true },
  })
  return sibling == null
}

async function markDeletedAndMaybeRemoveObject(file: { id: number; key: string }) {
  // 先标记后删对象：标记使该行退出引用计数，对象删除失败可幂等重试。
  await prisma.deliveryFile.update({
    where: { id: file.id },
    data: { status: 'deleted', deletedAt: new Date() },
  })
  if (await canDeleteObject(file.key, file.id)) {
    const storage = await getDeliveryStorage()
    await storage.delete(file.key)
  }
}

/** 场景 1：孤儿上传（超过宽限期仍未挂接任何规格/交付记录）。 */
export async function cleanupOrphanFiles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_GRACE_MS)
  const orphans = await prisma.deliveryFile.findMany({
    where: {
      status: 'active',
      createdAt: { lt: cutoff },
      offers: { none: {} },
      deliveryRecords: { none: {} },
    },
    select: { id: true, key: true },
    take: 200,
  })
  for (const file of orphans) {
    try {
      await markDeletedAndMaybeRemoveObject(file)
    } catch (err) {
      logger.warn({ err, fileId: file.id }, 'orphan delivery file cleanup failed')
    }
  }
  return orphans.length
}

/** 场景 2：tmp/ 遗留临时对象（上传中断残留；无 DB 行）。 */
export async function cleanupStaleTmpObjects(now = new Date()): Promise<number> {
  const storage = await getDeliveryStorage()
  const stale = await storage.listTmpKeysOlderThan(new Date(now.getTime() - ORPHAN_GRACE_MS))
  for (const key of stale) {
    try {
      await storage.delete(key)
    } catch (err) {
      logger.warn({ err, key }, 'stale tmp object cleanup failed')
    }
  }
  return stale.length
}

/**
 * 场景 3：退款保留期满。候选 = 有交付记录引用、不再被任何在售规格引用、
 * 且**所有**引用它的订单都已退款超过保留期的文件。任一订单非退款（含
 * delivered/closed——商家可复用文件）都不清理；窗口过期只断买家访问，
 * 不删文件。
 */
export async function cleanupRefundedFiles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REFUND_RETENTION_MS)
  const candidates = await prisma.deliveryFile.findMany({
    where: {
      status: 'active',
      offers: { none: {} },
      deliveryRecords: { some: {} },
    },
    select: {
      id: true,
      key: true,
      deliveryRecords: {
        select: { order: { select: { status: true, createdAt: true } }, deliveredAt: true },
      },
    },
    take: 200,
  })

  let cleaned = 0
  for (const file of candidates) {
    const allRefundedPastRetention = file.deliveryRecords.every(record => {
      if (record.order.status !== 'refunded') return false
      const anchor = record.deliveredAt ?? record.order.createdAt
      return anchor.getTime() < cutoff.getTime()
    })
    if (!allRefundedPastRetention) continue
    try {
      await markDeletedAndMaybeRemoveObject(file)
      cleaned++
    } catch (err) {
      logger.warn({ err, fileId: file.id }, 'refunded delivery file cleanup failed')
    }
  }
  return cleaned
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runFileCleanupBatch() {
  if (running) return
  running = true
  try {
    const orphans = await cleanupOrphanFiles()
    const tmp = await cleanupStaleTmpObjects()
    const refunded = await cleanupRefundedFiles()
    if (orphans + tmp + refunded > 0) {
      logger.info({ orphans, tmp, refunded }, 'delivery file cleanup batch done')
    }
  } catch (err) {
    logger.error({ err }, 'delivery file cleanup batch failed')
  } finally {
    running = false
  }
}

export function startFileCleanupCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runFileCleanupBatch().catch(err => logger.error({ err }, 'file cleanup initial run failed'))
  timer = setInterval(() => {
    runFileCleanupBatch().catch(err => logger.error({ err }, 'file cleanup tick failed'))
  }, CLEANUP_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: CLEANUP_INTERVAL_MS }, 'delivery file cleanup cron started')
}

export function stopFileCleanupCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('delivery file cleanup cron stopped')
}
