import { setCommercialActor } from '../catalog/offerRevisions.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import { countOpenFakaTasksForOffer } from '../fakaBridge/taskQueries.js'
import { normalizeFakaOfferIntegration } from '../../lib/fakaBridge/offerIntegration.js'
import { CATALOG_ERROR_CODES } from '../../lib/productCatalog/constants.js'
import { fakaCatalogSkuSet, fetchNormalizedFakaSource } from '../catalog/externalCatalog.js'
import { invalidateProductPublicCache } from '../../lib/productCatalog/publicCache.js'
import { lockProductRow } from '../catalog/productLock.js'
import { syncProductProjection } from '../../lib/offers.js'
import { loadOffer, serializeAdminOffer } from './offerAdmin.js'

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
  if (!fakaCatalogSkuSet(source).has(nextSku)) {
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
    await setCommercialActor(tx, { adminUserId }, 'admin/offerAdmin')
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

