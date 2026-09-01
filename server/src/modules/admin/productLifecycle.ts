import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import { syncProductProjection } from '../../lib/offers.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { CATALOG_ERROR_CODES, PRODUCT_STATUS } from '../catalog/constants.js'

type Tx = Prisma.TransactionClient
export type ArchivedFilter = 'exclude' | 'only' | 'all'

export function archivedWhere(filter: ArchivedFilter = 'exclude'): Prisma.ProductWhereInput {
  if (filter === 'only') return { archivedAt: { not: null } }
  if (filter === 'all') return {}
  return { archivedAt: null }
}

export async function lockProductRow(tx: Tx, productId: number) {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE
  `
  if (rows.length === 0) throw notFound('商品不存在')
  return tx.product.findUniqueOrThrow({ where: { id: productId } })
}

function restoreStatus(publishedAt: Date | null): 'draft' | 'inactive' {
  return publishedAt == null ? PRODUCT_STATUS.DRAFT : PRODUCT_STATUS.INACTIVE
}

export async function archiveAdminProduct(
  adminUserId: number,
  productId: number,
  input: { reason?: string | null } = {},
) {
  const result = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    if (product.archivedAt) {
      return {
        mode: 'archived' as const,
        productId,
        status: product.status,
        archivedAt: product.archivedAt.toISOString(),
        archivedByUserId: product.archivedByUserId,
        archiveReason: product.archiveReason,
        idempotent: true,
      }
    }

    const now = new Date()
    const reason = input.reason?.trim() || null
    await tx.product.update({
      where: { id: productId },
      data: {
        status: PRODUCT_STATUS.INACTIVE,
        archivedAt: now,
        archivedByUserId: adminUserId,
        archiveReason: reason,
      },
    })
    await tx.offer.updateMany({
      where: { productId },
      data: { status: 'inactive' },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '归档商品',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({
          name: product.name,
          previousStatus: product.status,
          reason,
        }),
      },
    })
    return {
      mode: 'archived' as const,
      productId,
      status: PRODUCT_STATUS.INACTIVE,
      archivedAt: now.toISOString(),
      archivedByUserId: adminUserId,
      archiveReason: reason,
      idempotent: false,
    }
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return result
}

export async function restoreAdminProduct(adminUserId: number, productId: number) {
  const result = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    if (!product.archivedAt) {
      return {
        productId,
        status: product.status,
        archivedAt: null,
        idempotent: true,
      }
    }
    const status = restoreStatus(product.publishedAt)
    await tx.product.update({
      where: { id: productId },
      data: {
        status,
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
      },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '恢复商品',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({
          name: product.name,
          status,
          offersRemainInactive: true,
        }),
      },
    })
    return {
      productId,
      status,
      archivedAt: null,
      idempotent: false,
    }
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return result
}

export async function countProductPurgeDependencies(tx: Tx | typeof prisma, productId: number) {
  const [
    orderCount,
    reviewCount,
    inventoryItemCount,
    inventoryLogCount,
    fakaTaskCount,
    promotionCampaignCount,
    editorialFeatureCount,
  ] = await Promise.all([
    tx.order.count({ where: { productId } }),
    tx.review.count({ where: { productId } }),
    tx.inventoryItem.count({ where: { productId } }),
    tx.inventoryLog.count({ where: { productId } }),
    tx.fakaBridgeTask.count({ where: { order: { productId } } }),
    tx.promotionCampaign.count({ where: { productId } }),
    tx.editorialFeature.count({ where: { productId } }),
  ])
  return {
    orderCount,
    reviewCount,
    inventoryItemCount,
    inventoryLogCount,
    fakaTaskCount,
    promotionCampaignCount,
    editorialFeatureCount,
  }
}

export async function purgeAdminProduct(adminUserId: number, productId: number) {
  const result = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    const dependencies = await countProductPurgeDependencies(tx, productId)
    const blocked = Object.values(dependencies).some(count => count > 0)
    const neverPublished = product.publishedAt == null && product.status === PRODUCT_STATUS.DRAFT
    if (!neverPublished || blocked) {
      throw new HttpError(
        409,
        CATALOG_ERROR_CODES.PRODUCT_PURGE_BLOCKED as ErrorCode,
        '商品存在历史依赖或曾经发布，拒绝永久删除',
        [
          { field: 'publishedAt', message: product.publishedAt ? 'published' : 'never' },
          { field: 'status', message: product.status },
          ...Object.entries(dependencies).map(([field, count]) => ({
            field,
            message: String(count),
          })),
        ],
      )
    }

    await tx.inventoryItem.deleteMany({ where: { productId } })
    await tx.inventoryLog.deleteMany({ where: { productId } })
    await tx.externalCatalogLink.deleteMany({ where: { productId } })
    await tx.offer.deleteMany({ where: { productId } })
    await tx.product.delete({ where: { id: productId } })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '永久删除商品',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({ name: product.name, mode: 'purge', dependencies }),
      },
    })
    return { mode: 'purged' as const, productId, dependencies }
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return result
}
