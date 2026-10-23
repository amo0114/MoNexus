import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Prisma, ProductVideoAsset } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { getDeliveryStorageForProvider, getDeliveryStorageForWrite } from '../../lib/storage/delivery.js'
import { registerStoredObject } from '../../lib/storage/storedObjectRegistry.js'
import { VIDEO_MAX_BYTES, VIDEO_POSTER_MAX_BYTES, VIDEO_TTL_SECONDS, videoKey } from '../../lib/storage/videoKeys.js'
import { assertPublicProductAccess, type ProductAudience } from '../products/visibility.js'
import type { VideoMetadata } from './processing.js'

const unavailable = () => new HttpError(409, 'VIDEO_ASSET_UNAVAILABLE', '视频已不可用或已关联其他商品，请重新上传')
export function videoSummary(asset: ProductVideoAsset | null) {
  return asset?.status === 'ready' ? { assetId: asset.id, durationMs: asset.durationMs, width: asset.width, height: asset.height, hasAudio: asset.hasAudio, moderation: asset.moderation, moderationVersion: asset.moderationVersion, moderationReason: asset.moderationReason } : null
}

/** Ordinary product DTOs contain approved media only, with no internal decisions. */
export function publicVideoSummary(asset: ProductVideoAsset | null) {
  return asset?.status === 'ready' && asset.moderation === 'approved'
    ? { assetId: asset.id, durationMs: asset.durationMs, width: asset.width, height: asset.height, hasAudio: asset.hasAudio } : null
}

/** Called with the Product lock held; asset lock order is deterministic and shared with cleanup. */
export async function prepareVideoChange(tx: Prisma.TransactionClient, productId: number, merchantId: number | null, previous: string | null, next: string | null) {
  for (const id of [...new Set([previous, next].filter((id): id is string => id !== null))].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "ProductVideoAsset" WHERE "id" = ${id} FOR UPDATE`
  }
  if (next !== null) {
    const asset = await tx.productVideoAsset.findUnique({ where: { id: next }, include: { videoStoredObject: true, posterStoredObject: true, product: { select: { id: true } } } })
    if (!asset || asset.status !== 'ready' || asset.merchantId !== merchantId || (asset.product && asset.product.id !== productId)
      || !asset.videoStoredObject || !asset.posterStoredObject
      || [asset.videoStoredObject, asset.posterStoredObject].some(o => o.status !== 'active' || o.bucketRole !== 'private' || o.source !== 'product_video' || o.providerConfigId !== asset.providerConfigId)
      || asset.videoStoredObject.objectKey !== videoKey(asset.id, false, asset.outputGeneration) || asset.posterStoredObject.objectKey !== videoKey(asset.id, true, asset.outputGeneration)) throw unavailable()
  }
  if (previous !== next) await tx.productVideoAsset.updateMany({ where: { id: { in: [previous, next].filter((id): id is string => id !== null) } }, data: { updatedAt: new Date() } })
}

export async function reserveVideo(merchantId: number | null, createdById: number) {
  const backend = await getDeliveryStorageForWrite()
  const asset = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(182714, ${merchantId ?? 0}::int)`
    const uploading = await tx.productVideoAsset.count({ where: { merchantId, status: { in: ['uploading', 'queued', 'processing'] } } })
    const ready = await tx.productVideoAsset.count({ where: { merchantId, status: 'ready', product: null } })
    if (uploading || ready >= 5) throw new HttpError(429, 'VIDEO_ASSET_QUOTA', '请稍后重试或先保存已上传的视频', undefined, 30)
    return tx.productVideoAsset.create({ data: { id: randomUUID(), merchantId, createdById, providerConfigId: backend.providerConfigId } })
  })
  return { asset, adapter: backend.adapter }
}

export async function finishVideo(asset: ProductVideoAsset, adapter: Awaited<ReturnType<typeof getDeliveryStorageForWrite>>['adapter'], files: { video: string; poster: string; metadata: VideoMetadata }, signal: AbortSignal, token?: string) {
  const video = await adapter.putStream(videoKey(asset.id, false, token ?? asset.outputGeneration), createReadStream(files.video), VIDEO_MAX_BYTES, { contentType: 'video/mp4', signal })
  const poster = await adapter.putStream(videoKey(asset.id, true, token ?? asset.outputGeneration), createReadStream(files.poster), VIDEO_POSTER_MAX_BYTES, { contentType: 'image/jpeg', signal })
  signal.throwIfAborted()
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ProductVideoAsset" WHERE "id" = ${asset.id} FOR UPDATE`
    const current = await tx.productVideoAsset.findUnique({ where: { id: asset.id } })
    if (!current || (token ? current.status !== 'processing' || current.processingToken !== token || !current.processingUntil || current.processingUntil <= new Date() : current.status !== 'uploading')) throw unavailable()
    const register = (posterImage: boolean) => registerStoredObject({ client: tx, bucketRole: 'private', providerConfigId: asset.providerConfigId,
      objectKey: videoKey(asset.id, posterImage, token ?? asset.outputGeneration), source: 'product_video', mimeType: posterImage ? 'image/jpeg' : 'video/mp4',
      size: posterImage ? poster.size : video.size, checksum: posterImage ? poster.sha256 : video.sha256 })
    const v = await register(false); const p = await register(true)
    return tx.productVideoAsset.update({ where: { id: asset.id }, data: { ...files.metadata, videoStoredObjectId: v.id, posterStoredObjectId: p.id, status: 'ready', outputGeneration: token ?? null, processingToken: null, processingUntil: null, processingError: null } })
  })
}

export async function signVideoAsset(assetId: string, approvedOnly = false) {
  const asset = await prisma.productVideoAsset.findUnique({ where: { id: assetId }, include: { videoStoredObject: true, posterStoredObject: true } })
  if (!asset || asset.status !== 'ready' || (approvedOnly && asset.moderation !== 'approved') || !asset.videoStoredObject || !asset.posterStoredObject
    || [asset.videoStoredObject, asset.posterStoredObject].some(o => o.status !== 'active' || o.source !== 'product_video' || o.bucketRole !== 'private' || o.providerConfigId !== asset.providerConfigId)
    || asset.videoStoredObject.objectKey !== videoKey(assetId, false, asset.outputGeneration) || asset.posterStoredObject.objectKey !== videoKey(assetId, true, asset.outputGeneration)) throw notFound()
  const adapter = await getDeliveryStorageForProvider(asset.providerConfigId)
  const video = await adapter.presignInlineVideo(videoKey(assetId, false, asset.outputGeneration), 'video/mp4', VIDEO_TTL_SECONDS)
  const poster = await adapter.presignInlineVideo(videoKey(assetId, true, asset.outputGeneration), 'image/jpeg', VIDEO_TTL_SECONDS)
  return { videoAssetId: assetId, playbackUrl: video.url, posterUrl: poster.url, expiresAt: video.expiresAt.toISOString() }
}

export async function productVideoPlayback(productId: number, audience: ProductAudience, expectedAssetId?: string) {
  if (process.env.PRODUCT_VIDEO_PLAYBACK_ENABLED === 'false') throw new HttpError(503, 'VIDEO_STORAGE_UNAVAILABLE', '视频暂不可播放')
  const product = await prisma.product.findUnique({ where: { id: productId }, include: {
    merchant: { select: { status: true } }, category: { select: { guestVisibility: true } }, guestEligibility: { select: { decision: true, reviewedRevision: true } },
  } })
  if (!product) throw notFound()
  assertPublicProductAccess(product, audience)
  if (expectedAssetId && product.promoVideoAssetId !== expectedAssetId) throw new HttpError(409, 'PRODUCT_MEDIA_CHANGED', '商品视频已更新，请刷新')
  if (!product.promoVideoAssetId) throw notFound()
  return signVideoAsset(product.promoVideoAssetId, true)
}

export function videoJob(asset: ProductVideoAsset) {
  return { assetId: asset.id, status: asset.status, error: asset.processingError, video: videoSummary(asset) }
}
