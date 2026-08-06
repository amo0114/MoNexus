import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'
import { getDeliveryStorage, getDeliveryStorageForProvider } from './storage/delivery.js'
import { withDeliveryKeyLock } from './deliveryKeyLock.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from './cronLease.js'

// Collect distinct provider ids that still have non-deleted delivery files or
// may hold tmp objects (active config + historical file bindings + env null).
async function listDeliveryProviderIdsForCleanup(): Promise<Array<number | null>> {
  const ids = new Set<number | null>([null])
  try {
    const rows = await prisma.deliveryFile.findMany({
      where: { status: { not: 'deleted' } },
      select: { storageProviderId: true },
      distinct: ['storageProviderId'],
    })
    for (const r of rows) ids.add(r.storageProviderId ?? null)
  } catch (err) {
    // Fail closed: only scan env bootstrap; never invent provider list on DB errors.
    logger.warn({ err }, 'listDeliveryProviderIdsForCleanup query failed; scanning env only')
  }
  try {
    const runtime = await prisma.storageRuntime.findUnique({ where: { id: 1 } })
    if (runtime?.activeConfigId != null) ids.add(runtime.activeConfigId)
  } catch {
    /* ignore */
  }
  return [...ids]
}

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
 * 4. 无行最终对象：晋升成功但 DeliveryFile 建行失败留下的对象。上传请求的
 *    失败路径**绝不**即时删最终对象（建行失败多与 DB 故障相关，此刻的
 *    引用查询不可信，误删会波及历史订单共享的同 hash 文件——评审 P0）；
 *    改由本场景按宽限期对照 DB 行兜底清理。
 */

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
const REFUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

/**
 * 同一 provider 作用域内是否还有其它非 deleted 行引用同 key。
 * 跨 provider 同 content-hash 不互相挡住删除（各桶独立）。
 */
async function canDeleteObject(
  key: string,
  excludeFileId: number,
  storageProviderId: number | null | undefined,
): Promise<boolean> {
  const sibling = await prisma.deliveryFile.findFirst({
    where: {
      key,
      status: { not: 'deleted' },
      id: { not: excludeFileId },
      storageProviderId: storageProviderId ?? null,
    },
    select: { id: true },
  })
  return sibling == null
}

async function markDeletedAndMaybeRemoveObject(file: {
  id: number
  key: string
  storageProviderId?: number | null
}) {
  // 先标记后删对象：标记使该行退出引用计数，对象删除失败可幂等重试。
  await prisma.deliveryFile.update({
    where: { id: file.id },
    data: { status: 'deleted', deletedAt: new Date() },
  })
  const providerId = file.storageProviderId ?? null
  if (await canDeleteObject(file.key, file.id, providerId)) {
    // SPEC-STORAGE-001：按对象绑定的 provider 删除，禁止对 active 写路径乱删
    const storage = await getDeliveryStorageForProvider(providerId)
    await storage.delete(file.key)
  }
}

/** 场景 1：孤儿上传（超过宽限期仍未挂接任何规格/交付记录）。 */
export async function cleanupOrphanFiles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_GRACE_MS)
  const orphans = await prisma.deliveryFile.findMany({
    where: {
      // revoked 同样参与清理——状态机是 active → revoked → deleted，
      // 已吊销且无引用的对象不能永久留在私有桶（评审 P1）。
      status: { in: ['active', 'revoked'] },
      createdAt: { lt: cutoff },
      offers: { none: {} },
      deliveryRecords: { none: {} },
    },
    select: { id: true, key: true, storageProviderId: true },
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

/** 场景 2：tmp/ 遗留临时对象（上传中断残留；无 DB 行）。扫 bootstrap + 已知 provider。 */
export async function cleanupStaleTmpObjects(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_GRACE_MS)
  const providerIds = await listDeliveryProviderIdsForCleanup()
  let cleaned = 0
  for (const providerId of providerIds) {
    try {
      const storage = await getDeliveryStorageForProvider(providerId)
      const stale = await storage.listTmpKeysOlderThan(cutoff)
      for (const key of stale) {
        try {
          await storage.delete(key)
          cleaned++
        } catch (err) {
          logger.warn({ err, key, providerId }, 'stale tmp object cleanup failed')
        }
      }
    } catch (err) {
      logger.warn({ err, providerId }, 'stale tmp scan failed for provider')
    }
  }
  // Always also scan current write backend (covers active with zero files yet)
  try {
    const write = await getDeliveryStorage()
    const stale = await write.listTmpKeysOlderThan(cutoff)
    for (const key of stale) {
      try {
        await write.delete(key)
        cleaned++
      } catch (err) {
        logger.warn({ err, key }, 'stale tmp object cleanup failed (write backend)')
      }
    }
  } catch (err) {
    logger.warn({ err }, 'stale tmp scan failed for write backend')
  }
  return cleaned
}

/**
 * 场景 3：退款保留期满。候选 = 有交付记录引用、不再被任何在售规格引用、
 * 且**所有**引用它的订单都已退款超过保留期的文件。任一订单非退款（含
 * delivered/closed——商家可复用文件）都不清理；窗口过期只断买家访问，
 * 不删文件。
 *
 * 保留期锚点 = **退款事件时间**（OrderStatusEvent toStatus='refunded' 的
 * 最近一条），不是交付时间——"100 天前交付、今天退款"必须再保留 90 天
 * （评审 P1）。查不到退款事件（绕过状态机的直改数据）→ 保守不清理。
 */
export async function cleanupRefundedFiles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REFUND_RETENTION_MS)
  const candidates = await prisma.deliveryFile.findMany({
    where: {
      status: { in: ['active', 'revoked'] },
      offers: { none: {} },
      deliveryRecords: { some: {} },
    },
    select: {
      id: true,
      key: true,
      storageProviderId: true,
      deliveryRecords: {
        select: {
          order: {
            select: {
              status: true,
              statusEvents: {
                where: { toStatus: 'refunded' },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
      },
    },
    take: 200,
  })

  let cleaned = 0
  for (const file of candidates) {
    const allRefundedPastRetention = file.deliveryRecords.every(record => {
      if (record.order.status !== 'refunded') return false
      const refundedAt = record.order.statusEvents[0]?.createdAt
      if (!refundedAt) return false
      return refundedAt.getTime() < cutoff.getTime()
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

/**
 * 场景 4：无 DeliveryFile 行引用的最终对象（晋升成功、建行失败）。
 * 只看超过宽限期的对象；判据必须是"确认无任何非 deleted 行"——DB 查询
 * 失败时宁可留到下一轮，也绝不删。
 *
 * 批量引用查询只是廉价初筛；真正的删除在**该 key 的 advisory lock 内**
 * 二次确认后执行——同内容重新上传从 promote 前持锁到建行完成，没有互斥
 * 时 GC 可能恰在"对象已存在故仅删 tmp、行未建成"的窗口删掉对象，让
 * 新行指向不存在的对象（评审 P0 竞态）。
 */
export async function cleanupUnreferencedObjects(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_GRACE_MS)
  const providerIds = await listDeliveryProviderIdsForCleanup()
  let cleaned = 0
  for (const providerId of providerIds) {
    let storage
    try {
      storage = await getDeliveryStorageForProvider(providerId)
    } catch (err) {
      logger.warn({ err, providerId }, 'unreferenced scan: cannot open provider')
      continue
    }
    let staleKeys: string[]
    try {
      staleKeys = await storage.listFinalKeysOlderThan(cutoff)
    } catch (err) {
      logger.warn({ err, providerId }, 'unreferenced scan: list failed')
      continue
    }
    for (let i = 0; i < staleKeys.length; i += 100) {
      const chunk = staleKeys.slice(i, i + 100)
      let referenced: Set<string>
      try {
        // Content-addressed keys may be shared: any non-deleted row blocks delete.
        const anyRows = await prisma.deliveryFile.findMany({
          where: { key: { in: chunk }, status: { not: 'deleted' } },
          select: { key: true },
        })
        referenced = new Set(anyRows.map(row => row.key))
      } catch (err) {
        logger.warn({ err, providerId }, 'unreferenced object scan query failed; keeping batch')
        continue
      }
      for (const key of chunk) {
        if (referenced.has(key)) continue
        try {
          const deleted = await withDeliveryKeyLock(key, async tx => {
            const row = await tx.deliveryFile.findFirst({
              where: { key, status: { not: 'deleted' } },
              select: { id: true },
            })
            if (row) return false
            await storage.delete(key)
            return true
          })
          if (deleted) cleaned++
        } catch (err) {
          logger.warn({ err, key, providerId }, 'unreferenced delivery object cleanup failed')
        }
      }
    }
  }
  return cleaned
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runFileCleanupBatch() {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    // P7a：舰队租约——领不到说明本窗口已有实例执行，跳过本 tick（test 直通）。
    lease = await acquireCronLeaseWithHeartbeat('fileCleanup', CLEANUP_INTERVAL_MS)
    if (!lease) return
    const orphans = await cleanupOrphanFiles()
    const tmp = await cleanupStaleTmpObjects()
    const refunded = await cleanupRefundedFiles()
    const unreferenced = await cleanupUnreferencedObjects()
    if (orphans + tmp + refunded + unreferenced > 0) {
      logger.info({ orphans, tmp, refunded, unreferenced }, 'delivery file cleanup batch done')
    }
  } catch (err) {
    logger.error({ err }, 'delivery file cleanup batch failed')
  } finally {
    lease?.release()
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
