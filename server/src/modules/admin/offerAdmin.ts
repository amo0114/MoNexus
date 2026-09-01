import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import { syncProductProjection } from '../../lib/offers.js'
import { normalizeFakaOfferIntegration } from '../../lib/fakaBridge/index.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { CATALOG_ERROR_CODES } from '../catalog/constants.js'
import { fetchNormalizedFakaSource } from '../catalog/externalCatalog.js'
import { lockProductRow } from './productLifecycle.js'

type Tx = Prisma.TransactionClient

const OPEN_FAKA_TASK_STATUS = ['pending', 'needs_reconcile'] as const

export type AdminOfferPatchInput = {
  name?: string
  price?: number
  originalPrice?: number | null
  validityDays?: number | null
  sortOrder?: number
}

async function loadOffer(tx: Tx, productId: number, offerId: number) {
  const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
  if (!offer) throw notFound('规格不存在')
  return offer
}

async function countOfferHistory(tx: Tx, offerId: number) {
  const [orderCount, inventoryCount, fakaTaskCount] = await Promise.all([
    tx.order.count({ where: { offerId } }),
    tx.inventoryItem.count({ where: { offerId } }),
    tx.fakaBridgeTask.count({
      where: {
        order: { offerId },
        OR: [
          { status: { in: [...OPEN_FAKA_TASK_STATUS] } },
          { revokeStatus: 'pending' },
        ],
      },
    }),
  ])
  return { orderCount, inventoryCount, fakaTaskCount }
}

export async function countOpenFakaTasksForOffer(tx: Tx | typeof prisma, offerId: number) {
  return tx.fakaBridgeTask.count({
    where: {
      order: { offerId },
      OR: [
        { status: { in: [...OPEN_FAKA_TASK_STATUS] } },
        { revokeStatus: 'pending' },
      ],
    },
  })
}

function assertOriginalPrice(price: number, originalPrice: number | null | undefined) {
  if (originalPrice != null && originalPrice < price) {
    throw badRequest('原价不能低于售价')
  }
}

export async function patchAdminOffer(
  adminUserId: number,
  productId: number,
  offerId: number,
  input: AdminOfferPatchInput,
) {
  const updated = await prisma.$transaction(async tx => {
    await lockProductRow(tx, productId)
    const offer = await loadOffer(tx, productId, offerId)
    const nextPrice = input.price ?? offer.price
    const nextOriginal = 'originalPrice' in input ? (input.originalPrice ?? null) : offer.originalPrice
    assertOriginalPrice(nextPrice, nextOriginal)

    const next = await tx.offer.update({
      where: { id: offer.id },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.price != null ? { price: input.price } : {}),
        ...('originalPrice' in input ? { originalPrice: input.originalPrice ?? null } : {}),
        ...('validityDays' in input ? { validityDays: input.validityDays ?? null } : {}),
        ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
      },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新规格',
        targetType: 'offer',
        targetId: offer.id,
        detail: JSON.stringify({
          productId,
          changedFields: Object.keys(input),
          before: { name: offer.name, price: offer.price, originalPrice: offer.originalPrice, validityDays: offer.validityDays, sortOrder: offer.sortOrder },
          after: { name: next.name, price: next.price, originalPrice: next.originalPrice, validityDays: next.validityDays, sortOrder: next.sortOrder },
        }),
      },
    })
    return next
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return serializeAdminOffer(updated)
}

export async function archiveAdminOffer(
  adminUserId: number,
  productId: number,
  offerId: number,
) {
  const updated = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    const offer = await loadOffer(tx, productId, offerId)
    if (offer.status === 'inactive') return offer

    if (offer.isDefault) {
      const otherDefault = await tx.offer.findFirst({
        where: { productId, isDefault: true, id: { not: offer.id } },
      })
      if (!otherDefault) {
        throw new HttpError(
          400,
          CATALOG_ERROR_CODES.DEFAULT_OFFER_ARCHIVE_BLOCKED as ErrorCode,
          '默认规格归档前请先指定另一个默认规格，或改为归档整个商品',
        )
      }
    }

    const next = await tx.offer.update({
      where: { id: offer.id },
      data: { status: 'inactive' },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '归档规格',
        targetType: 'offer',
        targetId: offer.id,
        detail: JSON.stringify({
          productId,
          productArchived: product.archivedAt != null,
          name: offer.name,
        }),
      },
    })
    return next
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return serializeAdminOffer(updated)
}

export async function restoreAdminOffer(
  adminUserId: number,
  productId: number,
  offerId: number,
) {
  const updated = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    if (product.archivedAt) {
      throw new HttpError(
        409,
        CATALOG_ERROR_CODES.PRODUCT_ARCHIVED as ErrorCode,
        '商品已归档，请先恢复商品后再恢复规格',
      )
    }
    const offer = await loadOffer(tx, productId, offerId)
    if (offer.status === 'active') return offer
    const next = await tx.offer.update({
      where: { id: offer.id },
      data: { status: 'active' },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '恢复规格',
        targetType: 'offer',
        targetId: offer.id,
        detail: JSON.stringify({ productId, name: offer.name }),
      },
    })
    return next
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return serializeAdminOffer(updated)
}

export async function makeDefaultAdminOffer(
  adminUserId: number,
  productId: number,
  offerId: number,
) {
  const updated = await prisma.$transaction(async tx => {
    await lockProductRow(tx, productId)
    const offer = await loadOffer(tx, productId, offerId)
    if (offer.isDefault) return offer
    await tx.offer.updateMany({
      where: { productId, isDefault: true },
      data: { isDefault: false },
    })
    const next = await tx.offer.update({
      where: { id: offer.id },
      data: { isDefault: true },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '设置默认规格',
        targetType: 'offer',
        targetId: offer.id,
        detail: JSON.stringify({ productId, name: offer.name }),
      },
    })
    return next
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return serializeAdminOffer(updated)
}

export async function previewRebindAdminOfferSku(
  productId: number,
  offerId: number,
  sku: string,
) {
  const offer = await prisma.offer.findFirst({ where: { id: offerId, productId } })
  if (!offer) throw notFound('规格不存在')
  if (offer.externalIntegration !== 'faka_bridge') {
    throw badRequest('仅 FakaBridge 规格支持重绑 SKU')
  }
  const nextSku = sku.trim().toLowerCase()
  const source = await fetchNormalizedFakaSourceForOffer(offer.externalSku)
  const known = new Set([
    ...source.periods.map(row => row.skuAlias),
    ...source.namedSkus.map(row => row.sku),
  ])
  if (!known.has(nextSku)) {
    throw badRequest(`Xboard 目录不包含 SKU ${nextSku}`)
  }
  const conflict = await prisma.offer.findFirst({
    where: {
      externalIntegration: 'faka_bridge',
      externalSku: nextSku,
      id: { not: offer.id },
    },
    select: { id: true, productId: true },
  })
  const openTasks = await countOpenFakaTasksForOffer(prisma, offer.id)
  return {
    offerId: offer.id,
    currentSku: offer.externalSku,
    nextSku,
    sourceHash: source.sourceHash,
    conflictProductId: conflict?.productId ?? null,
    openFakaTaskCount: openTasks,
    canConfirm: conflict == null && openTasks === 0,
  }
}

export async function rebindAdminOfferSku(
  adminUserId: number,
  productId: number,
  offerId: number,
  input: { sku: string; sourceHash: string },
) {
  const preview = await previewRebindAdminOfferSku(productId, offerId, input.sku)
  if (preview.sourceHash !== input.sourceHash) {
    throw new HttpError(409, CATALOG_ERROR_CODES.FAKA_SOURCE_CHANGED as ErrorCode, 'Xboard 套餐已变化，请重新预览')
  }
  if (preview.openFakaTaskCount > 0) {
    throw new HttpError(409, CATALOG_ERROR_CODES.FAKA_OPEN_TASK as ErrorCode, '存在未结 FakaBridge 任务，拒绝重绑 SKU')
  }
  if (preview.conflictProductId != null) {
    throw new HttpError(409, 'CONFLICT', '该 SKU 已关联其他规格', [
      { field: 'existingProductId', message: String(preview.conflictProductId) },
    ])
  }

  const updated = await prisma.$transaction(async tx => {
    await lockProductRow(tx, productId)
    const offer = await loadOffer(tx, productId, offerId)
    const openTasks = await countOpenFakaTasksForOffer(tx, offer.id)
    if (openTasks > 0) {
      throw new HttpError(409, CATALOG_ERROR_CODES.FAKA_OPEN_TASK as ErrorCode, '存在未结 FakaBridge 任务，拒绝重绑 SKU')
    }
    const faka = normalizeFakaOfferIntegration({
      externalIntegration: 'faka_bridge',
      externalSku: preview.nextSku,
      deliveryMode: offer.deliveryMode,
    }, { requireConfigured: true })
    const next = await tx.offer.update({
      where: { id: offer.id },
      data: {
        externalIntegration: faka.externalIntegration,
        externalSku: faka.externalSku,
      },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '重绑规格SKU',
        targetType: 'offer',
        targetId: offer.id,
        detail: JSON.stringify({
          productId,
          from: offer.externalSku,
          to: next.externalSku,
        }),
      },
    })
    return next
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return serializeAdminOffer(updated)
}

async function fetchNormalizedFakaSourceForOffer(externalSku: string | null) {
  if (!externalSku) throw badRequest('规格未绑定 SKU')
  const planMatch = externalSku.match(/^plan-(\d+)-/)
  if (planMatch) return fetchNormalizedFakaSource(Number(planMatch[1]))
  const link = await prisma.externalCatalogLink.findFirst({
    where: {
      product: { offers: { some: { externalSku } } },
    },
    select: { externalProductId: true },
  })
  if (!link) throw badRequest('无法从现有规格推断 Xboard planId')
  return fetchNormalizedFakaSource(Number(link.externalProductId))
}

function serializeAdminOffer(offer: {
  id: number
  productId: number
  name: string
  price: number
  originalPrice: number | null
  status: string
  isDefault: boolean
  sortOrder: number
  validityDays: number | null
  externalIntegration: string | null
  externalSku: string | null
}) {
  return {
    id: offer.id,
    productId: offer.productId,
    name: offer.name,
    price: offer.price,
    originalPrice: offer.originalPrice,
    status: offer.status,
    isDefault: offer.isDefault,
    sortOrder: offer.sortOrder,
    validityDays: offer.validityDays,
    externalIntegration: offer.externalIntegration,
    externalSku: offer.externalSku,
  }
}

export { countOfferHistory }
