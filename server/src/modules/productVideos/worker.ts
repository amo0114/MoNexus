import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat } from '../../lib/cronLease.js'
import { productVideoTempRoot } from '../../lib/productVideoTemp.js'
import { getDeliveryStorageForProvider } from '../../lib/storage/delivery.js'
import { VIDEO_SOURCE_MAX_BYTES, videoSourceKey } from '../../lib/storage/videoKeys.js'
import { HttpError } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { processVideo } from './processing.js'
import { finishVideo } from './service.js'

const PERIOD = 5_000
let timer: NodeJS.Timeout | undefined
let active: AbortController | undefined
let activeTask: Promise<void> | undefined

/** The object must exist before queued is committed. A crash before commit is GC'd. */
export async function enqueueVideo(id: string, input: string, signal: AbortSignal) {
  const asset = await prisma.productVideoAsset.findUniqueOrThrow({ where: { id } })
  const adapter = await getDeliveryStorageForProvider(asset.providerConfigId)
  await adapter.putStream(videoSourceKey(id), createReadStream(input), VIDEO_SOURCE_MAX_BYTES, { signal })
  const updated = await prisma.productVideoAsset.updateMany({ where: { id, status: 'uploading' }, data: { status: 'queued' } })
  if (!updated.count) throw new HttpError(409, 'VIDEO_ASSET_UNAVAILABLE', '上传已失效，请重试')
  return prisma.productVideoAsset.findUniqueOrThrow({ where: { id } })
}

/** Durable claim plus attempt-specific output keys fence stale workers, even after a restart. */
export async function runVideoBatch(parentSignal: AbortSignal = new AbortController().signal) {
  const lease = await acquireCronLeaseWithHeartbeat('product-video-processing', PERIOD)
  if (!lease) return
  let directory: string | undefined
  try {
    await prisma.productVideoAsset.updateMany({ where: { status: 'processing', processingUntil: { lt: new Date() }, attempts: { gte: 3 } }, data: { status: 'failed', processingError: '处理多次中断，请重新上传', processingToken: null, processingUntil: null } })
    const asset = await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ProductVideoAsset"
        WHERE attempts < 3 AND ((status = 'queued' AND "nextAttemptAt" <= now())
          OR (status = 'processing' AND "processingUntil" < now()))
        ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`
      if (!rows.length) return null
      return tx.productVideoAsset.update({ where: { id: rows[0].id }, data: { status: 'processing', attempts: { increment: 1 }, processingToken: randomUUID(), processingUntil: new Date(Date.now() + 600_000) } })
    })
    if (!asset) return
    const token = asset.processingToken!
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(540_000)])
    try {
      const root = productVideoTempRoot()
      await mkdir(root, { recursive: true, mode: 0o700 })
      const disk = await statfs(root)
      if (Number(disk.bavail) * Number(disk.bsize) < 512 * 1024 * 1024) throw new Error('insufficient processing space')
      directory = await mkdtemp(path.join(root, 'upload-'))
      const adapter = await getDeliveryStorageForProvider(asset.providerConfigId)
      const stream = await adapter.getObjectStream(videoSourceKey(asset.id), AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
      if (!stream) throw new HttpError(422, 'VIDEO_INVALID', '原片已不可用，请重新上传')
      let bytes = 0
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > VIDEO_SOURCE_MAX_BYTES ? new HttpError(413, 'VIDEO_TOO_LARGE', '原片过大') : null, chunk)
      } })
      const input = path.join(directory, 'source.mp4')
      await pipeline(stream, meter, createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
      const result = await processVideo(input, directory, signal)
      await finishVideo(asset, adapter, result, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), token)
      await adapter.delete(videoSourceKey(asset.id), AbortSignal.timeout(5_000)).catch(() => {})
    } catch (error) {
      const terminal = !parentSignal.aborted && error instanceof HttpError && [413, 422].includes(error.status)
      const failed = terminal || asset.attempts >= 3
      const updated = await prisma.productVideoAsset.updateMany({ where: { id: asset.id, status: 'processing', processingToken: token }, data: {
        status: failed ? 'failed' : 'queued', processingToken: null, processingUntil: null,
        nextAttemptAt: new Date(Date.now() + 30_000),
        processingError: failed ? (terminal ? (error as HttpError).message : '视频处理失败，请重新上传') : '处理暂时中断，正在重试',
      } })
      // GC removes failed originals too if this best-effort deletion is interrupted.
      if (failed && updated.count) {
        const adapter = await getDeliveryStorageForProvider(asset.providerConfigId).catch(() => null)
        await adapter?.delete(videoSourceKey(asset.id), AbortSignal.timeout(5_000)).catch(() => {})
      }
      logger.warn({ assetId: asset.id, terminal: failed }, 'video processing attempt interrupted')
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    lease.release()
  }
}
export function startVideoWorker() {
  if (timer) return
  const tick = () => {
    if (active) return
    const controller = new AbortController(); active = controller
    activeTask = runVideoBatch(controller.signal).catch(() => logger.warn('video worker tick failed')).finally(() => { if (active === controller) { active = undefined; activeTask = undefined } })
  }
  timer = setInterval(tick, PERIOD); timer.unref(); tick()
}
export function stopVideoWorker() { if (timer) clearInterval(timer); timer = undefined; active?.abort(); return activeTask }
