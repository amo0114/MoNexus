import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { lockProductRow } from '../catalog/productLock.js'
import { videoSummary } from './service.js'

export const videoModerationSchema = z.object({
  productId: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  action: z.enum(['approve', 'reject']),
  watched: z.boolean().optional(),
  listened: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict()

export async function listVideoReviews(moderation: 'pending' | 'approved' | 'rejected' = 'pending') {
  const assets = await prisma.productVideoAsset.findMany({ where: { status: 'ready', moderation, product: { isNot: null } }, include: { product: { select: { id: true, name: true, visibility: true } } }, orderBy: [{ moderation: 'asc' }, { createdAt: 'asc' }], take: 100 })
  return assets.map(a => ({ ...videoSummary(a)!, product: a.product }))
}
export async function reviewVideo(adminId: number, assetId: string, input: z.infer<typeof videoModerationSchema>) {
  return prisma.$transaction(async tx => {
    // Same lock order as merchant binding and guest approval. Reject stale review
    // if this asset has been detached/replaced while the administrator watched it.
    await lockProductRow(tx, input.productId)
    await tx.$queryRaw`SELECT id FROM "ProductVideoAsset" WHERE id = ${assetId} FOR UPDATE`
    const asset = await tx.productVideoAsset.findUnique({ where: { id: assetId }, include: { product: { select: { id: true } } } })
    if (!asset || asset.status !== 'ready') throw notFound()
    if (asset.product?.id !== input.productId || asset.moderationVersion !== input.expectedVersion) throw new HttpError(409, 'CONFLICT', '视频或审核状态已改变，请刷新后重新审核')
    if (input.action === 'approve' && (!input.watched || (asset.hasAudio && !input.listened))) throw new HttpError(400, 'VALIDATION_ERROR', '请确认已完整观看视频并听取音轨')
    if (input.action === 'reject' && !input.reason) throw new HttpError(400, 'VALIDATION_ERROR', '请填写拒绝或撤销原因')
    const updated = await tx.productVideoAsset.update({ where: { id: assetId }, data: {
      moderation: input.action === 'approve' ? 'approved' : 'rejected', moderationVersion: { increment: 1 },
      reviewedById: adminId, reviewedAt: new Date(), moderationReason: input.action === 'reject' ? input.reason : null,
    } })
    await tx.adminLog.create({ data: { adminUserId: adminId, action: 'product_video_review', targetType: 'product', targetId: input.productId, detail: JSON.stringify({ assetId, action: input.action, expectedVersion: input.expectedVersion, watched: input.watched === true, listened: input.listened === true, reason: input.reason ?? null }) } })
    return videoSummary(updated)
  })
}
