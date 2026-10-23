import { listVideoReviews, reviewVideo, videoModerationSchema } from './moderation.js'
import { enqueueVideo } from './worker.js'
import { Router, type Request, type Response, type NextFunction } from 'express'
import busboy from 'busboy'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { authenticate, authenticateIfPresent, requireActiveUser, requireActiveUserIfPresent, requireAdmin, requireAdminMfa, requireMerchant, requireVerifiedEmail } from '../../middlewares/auth.js'
import { getDeliveryStorage } from '../../lib/storage/delivery.js'
import { DeliveryMemoryStorage, verifyVideoToken } from '../../lib/storage/deliveryMemory.js'
import { VIDEO_SOURCE_MAX_BYTES, videoSourceKey } from '../../lib/storage/videoKeys.js'
import { productVideoTempRoot } from '../../lib/productVideoTemp.js'
import { resolveProductAudience } from '../products/visibility.js'
import { videoToolsAvailable } from './processing.js'
import { productVideoPlayback, reserveVideo, signVideoAsset, videoJob } from './service.js'

const router = Router()
const noStore = (_req: Request, res: Response, next: NextFunction) => { res.set('Cache-Control', 'private, no-store'); next() }
const run = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next) }
let busy = false
const mixedRole = (req: Request, res: Response, next: NextFunction) => req.user?.role === 'admin' ? requireAdminMfa(req, res, next) : requireMerchant(req, res, next)

async function owner(req: Request): Promise<number | null> {
  if (req.user!.role === 'admin') {
    if (req.query.merchantId === undefined) return null
    const id = z.coerce.number().int().positive().parse(req.query.merchantId)
    const merchant = await prisma.merchant.findUnique({ where: { id }, select: { status: true } })
    if (merchant?.status !== 'active') throw notFound()
    return id
  }
  if (req.query.merchantId !== undefined) throw new HttpError(403, 'FORBIDDEN', '不能指定其他商家')
  const merchant = await prisma.merchant.findUnique({ where: { userId: req.user!.userId }, select: { id: true, status: true } })
  if (merchant?.status !== 'active') throw notFound()
  return merchant.id
}

function receive(req: Request, destination: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let bb: ReturnType<typeof busboy>
    try { bb = busboy({ headers: req.headers, limits: { files: 1, fields: 0, parts: 2, fileSize: VIDEO_SOURCE_MAX_BYTES + 1 } }) }
    catch { reject(new HttpError(422, 'VIDEO_INVALID', '请选择一个视频文件')); return }
    const receiveAbort = new AbortController()
    let writing: Promise<void> | undefined
    let sawFile = false; let settled = false
    const cleanup = () => { signal.removeEventListener('abort', abort); req.unpipe(bb) }
    const fail = (err: unknown) => {
      if (settled) return
      settled = true; cleanup(); req.resume()
      // Busboy limit events fire inside its parser. Destroying synchronously
      // clears _fileStream before the parser finishes setting truncated.
      queueMicrotask(() => {
        receiveAbort.abort(); bb.destroy()
        void (writing ?? Promise.resolve()).catch(() => {}).then(() => reject(err))
      })
    }
    const abort = () => fail(new HttpError(422, 'VIDEO_INVALID', '上传已中断或超时，请重试'))
    signal.addEventListener('abort', abort, { once: true })
    bb.on('file', (field, file) => {
      // Even a rejected/ignored part may be destroyed by Busboy after a limit
      // event. Consume its error before deciding whether to start a pipeline.
      file.on('error', fail)
      if (field !== 'file' || settled) { file.resume(); fail(new HttpError(422, 'VIDEO_INVALID', '请选择一个视频文件')); return }
      sawFile = true
      let size = 0
      const meter = new Transform({ transform(chunk, _enc, cb) {
        size += chunk.length
        cb(size > VIDEO_SOURCE_MAX_BYTES ? new HttpError(413, 'VIDEO_TOO_LARGE', '原片不能超过 90 MiB') : null, chunk)
      } })
      file.once('limit', () => fail(new HttpError(413, 'VIDEO_TOO_LARGE', '原片不能超过 90 MiB')))
      writing = pipeline(file, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: receiveAbort.signal })
      void writing.catch(fail)
    })
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) bb.once(event, () => fail(new HttpError(422, 'VIDEO_INVALID', '只允许上传一个视频文件')))
    bb.once('error', fail)
    bb.once('close', () => {
      if (settled) return
      if (!sawFile || !writing) { fail(new HttpError(400, 'NO_FILE', '请选择视频文件')); return }
      void writing.then(() => { if (!settled) { settled = true; cleanup(); resolve() } }, fail)
    })
    if (signal.aborted) abort()
    else req.pipe(bb)
  })
}

router.get('/admin/product-videos/reviews', noStore, authenticate, requireActiveUser, requireAdmin, requireAdminMfa, run(async (req, res) => {
  res.json(await listVideoReviews(z.enum(['pending', 'approved', 'rejected']).default('pending').parse(req.query.moderation)))
}))
router.post('/admin/product-videos/:assetId/review', noStore, authenticate, requireActiveUser, requireAdmin, requireAdminMfa, run(async (req, res) => {
  res.json(await reviewVideo(req.user!.userId, z.string().uuid().parse(req.params.assetId), videoModerationSchema.parse(req.body)))
}))

router.get('/admin/product-videos/health', noStore, authenticate, requireActiveUser, requireAdmin, requireAdminMfa, run(async (_req, res) => {
  res.json({ uploadEnabled: process.env.PRODUCT_VIDEO_UPLOAD_ENABLED !== 'false', playbackEnabled: process.env.PRODUCT_VIDEO_PLAYBACK_ENABLED !== 'false', toolsAvailable: await videoToolsAvailable(), busy })
}))

router.post('/uploads/product-video', noStore, authenticate, requireActiveUser, requireVerifiedEmail, mixedRole, run(async (req, res) => {
  if (process.env.PRODUCT_VIDEO_UPLOAD_ENABLED === 'false') throw new HttpError(503, 'VIDEO_PROCESSING_UNAVAILABLE', '视频上传暂不可用')
  const merchantId = await owner(req)
  if (busy) throw new HttpError(429, 'VIDEO_UPLOAD_BUSY', '视频处理中，请稍后重试', undefined, 30)
  busy = true
  let directory: string | undefined
  let reservation: Awaited<ReturnType<typeof reserveVideo>> | undefined
  let completed = false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 240_000)
  const disconnected = () => controller.abort()
  const responseClosed = () => { if (!res.writableEnded) disconnected() }
  req.once('aborted', disconnected)
  res.once('close', responseClosed)
  try {
    if (!await videoToolsAvailable()) throw new HttpError(503, 'VIDEO_PROCESSING_UNAVAILABLE', '视频上传暂不可用')
    const tempRoot = productVideoTempRoot()
    await mkdir(tempRoot, { recursive: true, mode: 0o700 })
    const disk = await statfs(tempRoot)
    if (Number(disk.bavail) * Number(disk.bsize) < 512 * 1024 * 1024) throw new HttpError(503, 'VIDEO_PROCESSING_UNAVAILABLE', '视频处理空间不足，请稍后重试')
    reservation = await reserveVideo(merchantId, req.user!.userId)
    directory = await mkdtemp(path.join(tempRoot, 'upload-'))
    const input = path.join(directory, 'input.mp4')
    await receive(req, input, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]))
    const asset = await enqueueVideo(reservation.asset.id, input, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
    completed = true
    res.status(202).json(videoJob(asset))
  } catch (err) {
    if (reservation && !completed) {
      const failed = await prisma.productVideoAsset.updateMany({ where: { id: reservation.asset.id, status: 'uploading' }, data: { status: 'failed' } }).catch(() => null)
      if (failed?.count) await reservation.adapter.delete(videoSourceKey(reservation.asset.id), AbortSignal.timeout(5000)).catch(() => {})
    }
    if (err instanceof HttpError || err instanceof z.ZodError) throw err
    throw new HttpError(503, 'VIDEO_STORAGE_UNAVAILABLE', '视频上传失败，请稍后重试')
  } finally {
    clearTimeout(timeout); req.removeListener('aborted', disconnected); res.removeListener('close', responseClosed)
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    busy = false
  }
}))

for (const actor of ['merchant', 'admin'] as const) {
  const role = actor === 'admin' ? [requireAdmin, requireAdminMfa] : [requireMerchant]
  router.get(`/${actor}/product-videos`, noStore, authenticate, requireActiveUser, ...role, run(async (req, res) => {
    const merchantId = await owner(req)
    const [available, failures] = await Promise.all([
      prisma.productVideoAsset.findMany({ where: { merchantId, product: null, status: { in: ['queued', 'processing', 'ready'] } }, orderBy: { createdAt: 'desc' }, take: 6 }),
      prisma.productVideoAsset.findMany({ where: { merchantId, product: null, status: 'failed', createdAt: { gt: new Date(Date.now() - 86400_000) } }, orderBy: { createdAt: 'desc' }, take: 3 }),
    ])
    // Failed attempts must never hide ready assets that still consume quota.
    res.json([...available, ...failures].map(videoJob))
  }))
  router.get(`/${actor}/product-videos/:assetId/status`, noStore, authenticate, requireActiveUser, ...role, run(async (req, res) => {
    const id = z.string().uuid().parse(req.params.assetId)
    const asset = await prisma.productVideoAsset.findUnique({ where: { id } })
    if (!asset || (actor === 'merchant' && asset.merchantId !== await owner(req))) throw notFound()
    res.json(videoJob(asset))
  }))
}

router.get('/merchant/product-videos/:assetId/preview', noStore, authenticate, requireActiveUser, requireMerchant, run(async (req, res) => {
  const id = z.string().uuid().parse(req.params.assetId)
  const merchantId = await owner(req)
  const asset = await prisma.productVideoAsset.findUnique({ where: { id } })
  if (!asset || asset.merchantId !== merchantId) throw notFound()
  res.json(await signVideoAsset(id))
}))
router.get('/admin/product-videos/:assetId/preview', noStore, authenticate, requireActiveUser, requireAdmin, requireAdminMfa, run(async (req, res) => {
  res.json(await signVideoAsset(z.string().uuid().parse(req.params.assetId)))
}))
router.get('/products/:id/video-playback', noStore, authenticateIfPresent, requireActiveUserIfPresent, run(async (req, res) => {
  const productId = z.coerce.number().int().positive().parse(req.params.id)
  const expected = z.string().uuid().optional().parse(req.query.expectedVideoAssetId)
  res.json(await productVideoPlayback(productId, resolveProductAudience(req.user), expected))
}))

/** Test/dev adapter only. Token scope cannot authorize inline rendering of paid files. */
router.get('/uploads/product-video-signed/:token', noStore, run(async (req, res) => {
  const payload = verifyVideoToken(String(req.params.token))
  if (!payload) { res.status(403).end(); return }
  const adapter = await getDeliveryStorage()
  if (!(adapter instanceof DeliveryMemoryStorage)) throw notFound()
  const buffer = adapter.getBlob(payload.key)
  if (!buffer) throw notFound()
  res.set({ 'Content-Type': payload.mimeType, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' })
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
    let start = match?.[1] ? Number(match[1]) : 0
    let end = match?.[2] ? Number(match[2]) : buffer.length - 1
    if (match && !match[1] && match[2]) { start = Math.max(0, buffer.length - Number(match[2])); end = buffer.length - 1 }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= buffer.length || end < start) {
      res.set('Content-Range', `bytes */${buffer.length}`).status(416).end(); return
    }
    end = Math.min(end, buffer.length - 1)
    res.set('Content-Range', `bytes ${start}-${end}/${buffer.length}`).status(206).send(buffer.subarray(start, end + 1)); return
  }
  res.send(buffer)
}))
export { router as productVideoRoutes }
