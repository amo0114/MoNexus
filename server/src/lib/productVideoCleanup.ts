import { readdir, lstat, rm } from 'node:fs/promises'
import path from 'node:path'
import { productVideoTempRoot } from './productVideoTemp.js'
import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { getDeliveryStorageForProvider } from './storage/delivery.js'
import { VIDEO_KEY, VIDEO_SOURCE_KEY, videoKey, videoSourceKey } from './storage/videoKeys.js'

const GRACE_MS = 24 * 60 * 60 * 1000
/** Claim under asset lock; never acquire a Product lock after an asset lock. */
export async function cleanupProductVideos(now = new Date()) {
  const tempRoot = productVideoTempRoot()
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^upload-[A-Za-z0-9]{6}$/.test(entry.name)) continue
    const directory = path.join(tempRoot, entry.name)
    try {
      const info = await lstat(directory)
      if (info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < now.getTime() - 10 * 60_000) await rm(directory, { recursive: true, force: true })
    } catch { /* Another process may already have removed it. */ }
  }
  const cutoff = new Date(now.getTime() - GRACE_MS)
  await prisma.productVideoAsset.updateMany({ where: { status: 'uploading', updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }, data: { status: 'failed' } })
  const candidates = await prisma.productVideoAsset.findMany({ where: { product: null, OR: [{ status: 'deleting' }, { updatedAt: { lt: cutoff } }] }, take: 100, orderBy: { updatedAt: 'asc' } })
  let cleaned = 0
  for (const candidate of candidates) {
    try {
      const claimed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "ProductVideoAsset" WHERE "id" = ${candidate.id} FOR UPDATE`
        const current = await tx.productVideoAsset.findUnique({ where: { id: candidate.id }, include: { product: { select: { id: true } } } })
        if (!current || current.product || ['uploading', 'queued', 'processing'].includes(current.status) || (current.status !== 'deleting' && current.updatedAt >= cutoff)) return null
        return tx.productVideoAsset.update({ where: { id: current.id }, data: { status: 'deleting' } })
      })
      if (!claimed) continue
      const storage = await getDeliveryStorageForProvider(claimed.providerConfigId)
      await storage.delete(videoKey(claimed.id, false, claimed.outputGeneration)); await storage.delete(videoKey(claimed.id, true, claimed.outputGeneration))
      await storage.delete(videoSourceKey(claimed.id))
      await prisma.$transaction(async tx => {
        await tx.productVideoAsset.delete({ where: { id: claimed.id } })
        await tx.storedObject.updateMany({ where: { id: { in: [claimed.videoStoredObjectId, claimed.posterStoredObjectId].filter((id): id is number => id !== null) } }, data: { status: 'deleted' } })
      })
      cleaned++
    } catch { logger.warn({ assetId: candidate.id }, 'promotional video cleanup failed; retained for retry') }
  }
  // A crash after upload but before registration leaves a namespaced object with no asset.
  const providers = new Set<number | null>([null])
  const rows = await prisma.productVideoAsset.findMany({ distinct: ['providerConfigId'], select: { providerConfigId: true } })
  const configs = await prisma.storageProviderConfig.findMany({ select: { id: true } })
  for (const row of rows) providers.add(row.providerConfigId)
  for (const row of configs) providers.add(row.id)
  for (const providerId of providers) {
    try {
      const storage = await getDeliveryStorageForProvider(providerId)
      for (const key of await storage.listFinalKeysOlderThan(cutoff)) {
        const match = VIDEO_KEY.exec(key)
        const source = VIDEO_SOURCE_KEY.exec(key)
        if (!match && !source) continue
        const asset = await prisma.productVideoAsset.findUnique({ where: { id: (match ?? source)![1] } })
        const preserve = source ? asset && ['uploading', 'queued', 'processing'].includes(asset.status)
          : asset && (key === videoKey(asset.id, false, asset.outputGeneration) || key === videoKey(asset.id, true, asset.outputGeneration)
            || (asset.status === 'processing' && match![2] === asset.processingToken))
        if (!preserve) await storage.delete(key)
      }
    } catch { logger.warn({ providerId }, 'promotional orphan scan failed; keeping objects') }
  }
  return cleaned
}
