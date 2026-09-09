import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import { syncProductProjection } from '../../lib/offers.js'
import { normalizeFakaOfferIntegration } from '../../lib/fakaBridge/index.js'
import { assertProductDeliveryConfiguration } from '../../lib/productCommercial.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { CATALOG_ERROR_CODES } from '../catalog/constants.js'
import { fakaCatalogSkuSet, fetchNormalizedFakaSource } from '../catalog/externalCatalog.js'
import {
  canonicalFixedStructuredText,
  normalizeFixedStructuredContent,
} from '../catalog/structuredFixedContent.js'
import { lockProductRow } from './productLifecycle.js'

type Tx = Prisma.TransactionClient

const OPEN_FAKA_TASK_STATUS = ['pending', 'needs_reconcile'] as const

type DeliveryMode = 'instant_inventory' | 'instant_fixed' | 'manual_service'
type StockMode = 'limited' | 'unlimited'
type FixedContentType = 'text' | 'url' | 'file'
type OfferAttributes = Record<string, string | number | boolean | string[]>

export type AdminOfferPatchInput = {
  name?: string
  price?: number
  originalPrice?: number | null
  validityDays?: number | null
  sortOrder?: number
  attributes?: OfferAttributes
  deliveryMode?: DeliveryMode
  stockMode?: StockMode
  fixedContentType?: FixedContentType
  fixedContent?: string | null
  fixedFileId?: number | null
  fixedStructuredContent?: unknown
}

function deliveryFieldsTouched(input: AdminOfferPatchInput) {
  return (
    'deliveryMode' in input
    || 'stockMode' in input
    || 'fixedContentType' in input
    || 'fixedContent' in input
    || 'fixedFileId' in input
    || 'fixedStructuredContent' in input
  )
}

async function assertPlatformDeliveryFile(tx: Tx, fileId: number) {
  const file = await tx.deliveryFile.findFirst({
    where: { id: fileId, merchantId: null },
    select: { status: true },
  })
  if (!file) throw notFound('交付文件不存在')
  if (file.status !== 'active') throw badRequest('交付文件已不可用，请重新上传')
}

function resolveStructuredFixedContent(
  structuredInput: unknown,
  fixedContent: string | null,
) {
  if (structuredInput == null) {
    return { fixedContent, structured: null as ReturnType<typeof normalizeFixedStructuredContent> | null }
  }
  if (fixedContent != null) {
    throw badRequest('结构化固定内容与 fixedContent 不能同时提交')
  }
  const structured = normalizeFixedStructuredContent(structuredInput)
  return { fixedContent: canonicalFixedStructuredText(structured), structured }
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

export function assertOriginalPrice(price: number, originalPrice: number | null | undefined) {
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
    const product = await lockProductRow(tx, productId)
    const offer = await loadOffer(tx, productId, offerId)
    const nextPrice = input.price ?? offer.price
    const nextOriginal = 'originalPrice' in input ? (input.originalPrice ?? null) : offer.originalPrice
    assertOriginalPrice(nextPrice, nextOriginal)

    const touchingDelivery = deliveryFieldsTouched(input)
    if (touchingDelivery) {
      if (product.merchantId != null) {
        throw badRequest('平台套餐履约字段仅用于平台自营商品')
      }
      if (offer.externalIntegration != null) {
        throw badRequest('外部开通规格请使用专用流程，不能改写履约或文件字段')
      }
    }

    const nextDeliveryMode = input.deliveryMode ?? offer.deliveryMode
    if (nextDeliveryMode !== offer.deliveryMode) {
      const { orderCount, inventoryCount } = await countOfferHistory(tx, offer.id)
      if (orderCount > 0 || inventoryCount > 0) {
        throw badRequest('该规格已有库存记录或订单，不能修改履约模式')
      }
    }
    const nextStockMode = input.stockMode
      ?? (nextDeliveryMode !== offer.deliveryMode
        ? (nextDeliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
        : offer.stockMode)
    const nextFixedContentType = input.fixedContentType ?? offer.fixedContentType
    const nextFixedFileId = 'fixedFileId' in input ? (input.fixedFileId ?? null) : offer.fixedFileId
    const structuredWrite = 'fixedStructuredContent' in input
      ? resolveStructuredFixedContent(
        input.fixedStructuredContent,
        'fixedContent' in input ? (input.fixedContent ?? null) : offer.fixedContent,
      )
      : {
        fixedContent: 'fixedContent' in input ? (input.fixedContent ?? null) : offer.fixedContent,
        structured: null,
      }
    const nextFixedContent = nextDeliveryMode === 'instant_fixed' ? structuredWrite.fixedContent : null

    if (touchingDelivery) {
      assertProductDeliveryConfiguration({
        deliveryMode: nextDeliveryMode,
        stockMode: nextStockMode,
        effectiveStock: offer.stock,
        fixedContent: nextDeliveryMode === 'instant_fixed' ? nextFixedContent : undefined,
        fixedContentType: nextFixedContentType,
        fixedFileId: nextFixedFileId,
        allowFileForm: true,
      })
      if (nextFixedFileId != null && nextFixedFileId !== offer.fixedFileId) {
        await assertPlatformDeliveryFile(tx, nextFixedFileId)
      }
    }

    const next = await tx.offer.update({
      where: { id: offer.id },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.price != null ? { price: input.price } : {}),
        ...('originalPrice' in input ? { originalPrice: input.originalPrice ?? null } : {}),
        ...('validityDays' in input ? { validityDays: input.validityDays ?? null } : {}),
        ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
        ...(input.attributes != null ? { attributes: input.attributes as Prisma.InputJsonValue } : {}),
        ...(touchingDelivery ? {
          deliveryMode: nextDeliveryMode,
          stockMode: nextStockMode,
          fixedContentType: nextFixedContentType,
          fixedContent: nextFixedContent,
          ...('fixedFileId' in input ? { fixedFileId: input.fixedFileId ?? null } : {}),
          ...('fixedStructuredContent' in input
            ? {
              fixedStructuredContent: structuredWrite.structured == null
                ? Prisma.DbNull
                : structuredWrite.structured as unknown as Prisma.InputJsonValue,
            }
            : {}),
          ...(nextDeliveryMode === 'instant_inventory' && offer.deliveryMode !== 'instant_inventory'
            ? { stock: 0 }
            : {}),
        } : {}),
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

export async function createPlatformOffer(
  adminUserId: number,
  productId: number,
  input: {
    name: string
    price: number
    originalPrice: number | null
    attributes: Record<string, string | number | boolean | string[]>
    deliveryMode: DeliveryMode
    stockMode: StockMode
    validityDays: number | null
    fixedContentType: FixedContentType
    fixedContent: string | null
    fixedFileId: number | null
    fixedStructuredContent: unknown
    deliveryFields: unknown
    autoProvision: boolean
  },
) {
  const created = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    if (product.merchantId != null) {
      throw badRequest('平台套餐接口仅用于平台自营商品')
    }
    if (input.autoProvision) {
      throw badRequest('平台商品不能开启商家自动开通')
    }
    const structuredWrite = resolveStructuredFixedContent(input.fixedStructuredContent, input.fixedContent)
    assertProductDeliveryConfiguration({
      deliveryMode: input.deliveryMode,
      stockMode: input.stockMode,
      effectiveStock: 0,
      fixedContent: structuredWrite.fixedContent,
      fixedContentType: input.fixedContentType,
      fixedFileId: input.fixedFileId,
      allowFileForm: true,
    })
    if (input.fixedFileId != null) {
      await assertPlatformDeliveryFile(tx, input.fixedFileId)
    }
    const maxSort = await tx.offer.aggregate({ where: { productId }, _max: { sortOrder: true } })
    const offer = await tx.offer.create({
      data: {
        productId,
        name: input.name,
        price: input.price,
        originalPrice: input.originalPrice,
        isDefault: false,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        status: 'active',
        deliveryMode: input.deliveryMode,
        stockMode: input.stockMode,
        stock: 0,
        fixedContent: input.deliveryMode === 'instant_fixed' ? structuredWrite.fixedContent : null,
        fixedContentType: input.fixedContentType,
        fixedFileId: input.fixedFileId,
        validityDays: input.validityDays,
        autoProvision: false,
        attributes: input.attributes as Prisma.InputJsonValue,
        ...(input.deliveryFields != null
          ? { deliveryFields: input.deliveryFields as Prisma.InputJsonValue }
          : {}),
        ...(structuredWrite.structured
          ? { fixedStructuredContent: structuredWrite.structured as unknown as Prisma.InputJsonValue }
          : {}),
      },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '创建规格',
        targetType: 'offer',
        targetId: offer.id,
        detail: JSON.stringify({ productId, name: offer.name }),
      },
    })
    return offer
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return serializeAdminOffer(created)
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
    if (offer.status !== 'active') {
      throw new HttpError(
        409,
        CATALOG_ERROR_CODES.DEFAULT_OFFER_REQUIRES_ACTIVE as ErrorCode,
        '已归档规格不能设为默认，请先恢复',
      )
    }
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
  deliveryMode: string
  stockMode: string
  fixedContentType: string
  fixedFileId: number | null
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
    deliveryMode: offer.deliveryMode,
    stockMode: offer.stockMode,
    fixedContentType: offer.fixedContentType,
    fixedFileId: offer.fixedFileId,
    externalIntegration: offer.externalIntegration,
    externalSku: offer.externalSku,
  }
}

export { countOfferHistory }
