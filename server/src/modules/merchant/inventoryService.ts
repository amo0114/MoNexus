import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import {
  analyzeInventoryForOffer,
  assertConfirmableInventoryAnalysis,
  isInventoryContentUniqueViolation,
  type InventoryImportPayload,
} from '../../lib/inventoryImport.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { parseStoredDeliveryFields, structuredContentToJson } from '../../lib/deliveryFields.js'
import { getDefaultOffer } from '../../lib/offers.js'
import { adjustOfferCapacity } from '../../lib/offerCapacity.js'

import { resolvePagination } from '../../lib/pagination.js'

/** 商家商品级 Offer 解析：显式 offerId 必须属于该商品；缺省仅兼容旧客户端（D-CAT-13）。 */
type InventoryClient = typeof prisma | Prisma.TransactionClient

async function resolveMyOffer(
  client: InventoryClient,
  productId: number,
  offerId?: number
) {
  if (offerId != null) {
    const offer = await client.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')
    return offer
  }
  return getDefaultOffer(client, productId)
}

/** preview 领域分析（Merchant/Admin 共用分析器，AC-CAT-009）。绝不回显既有库存 content。 */
async function previewOfferInventory(
  productId: number,
  offer: { deliveryFields: unknown },
  payload: InventoryImportPayload
) {
  const analysis = await analyzeInventoryForOffer(productId, offer, payload)
  if ('rowErrors' in analysis) {
    return {
      totalRows: analysis.totalRows,
      validRows: analysis.validRows,
      emptyRows: analysis.emptyRows,
      duplicateRows: analysis.duplicateRows,
      existingDuplicateRows: analysis.existingDuplicateRows,
      rowErrors: analysis.rowErrors,
      canImport: analysis.canImport,
      // 预览表格：模板 + 前 20 行解析结果（值不落库前仅回显给上传者本人）。
      structured: {
        fields: parseStoredDeliveryFields(offer.deliveryFields),
        rows: analysis.itemsToImport.slice(0, 20).map(item => item.structuredContent.values),
      },
    }
  }
  return {
    totalRows: analysis.totalRows,
    validRows: analysis.validRows,
    emptyRows: analysis.emptyRows,
    duplicateRows: analysis.duplicateRows,
    existingDuplicateRows: analysis.existingDuplicateRows,
    canImport: analysis.canImport,
  }
}

export async function previewMyInventoryImport(
  merchantId: number,
  productId: number,
  payload: InventoryImportPayload & { offerId?: number }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')
  // 旧兼容路径：未指定 offerId 落到默认 Offer（单 SKU 无感）。
  const offer = await resolveMyOffer(prisma, productId, payload.offerId)
  if (offer.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }
  return previewOfferInventory(productId, offer, payload)
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：offerId 显式必填。 */
export async function previewMyOfferInventory(
  merchantId: number,
  productId: number,
  offerId: number,
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')
  const offer = await resolveMyOffer(prisma, productId, offerId)
  if (offer.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }
  return previewOfferInventory(productId, offer, payload)
}

/**
 * Adjust the numeric availability of limited fixed-content/manual products.
 * Unlike instant inventory, these products do not have one secret per buyer;
 * Product.stock therefore means remaining sale/service capacity.  A
 * conditional decrement keeps concurrent reductions from going below zero.
 * 旧兼容路径：未指定 offerId 时落到默认 Offer（单 SKU 无感）。
 */
export async function adjustMyProductCapacity(
  merchantId: number,
  actorUserId: number,
  productId: number,
  input: { delta: number; reason: string; offerId?: number }
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, merchantId },
    select: { id: true },
  })
  if (!product) throw notFound('商品不存在')

  const result = await prisma.$transaction(async tx => {
    const offer = await resolveMyOffer(tx, productId, input.offerId)
    return adjustOfferCapacity(tx, productId, offer, merchantId, actorUserId, input)
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：capacity 调整显式 offerId。 */
export async function adjustMyOfferCapacity(
  merchantId: number,
  actorUserId: number,
  productId: number,
  offerId: number,
  input: { delta: number; reason: string }
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, merchantId },
    select: { id: true },
  })
  if (!product) throw notFound('商品不存在')

  const result = await prisma.$transaction(async tx => {
    const offer = await resolveMyOffer(tx, productId, offerId)
    return adjustOfferCapacity(tx, productId, offer, merchantId, actorUserId, input)
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

/** import confirm 核心（T-CAT-BE-004）：事务内重算 + 写库 + 审计，Merchant/Admin 共用。 */
async function confirmOfferInventoryImport(
  tx: Prisma.TransactionClient,
  productId: number,
  offer: { id: number; deliveryFields: unknown },
  merchantId: number | null,
  actorUserId: number,
  payload: InventoryImportPayload
) {
  const analysis = await analyzeInventoryForOffer(productId, offer, payload, tx)
  assertConfirmableInventoryAnalysis(analysis)

  await tx.inventoryItem.createMany({
    data: analysis.itemsToImport.map(item =>
      typeof item === 'string'
        ? { productId, offerId: offer.id, content: item }
        : {
            productId,
            offerId: offer.id,
            content: item.content,
            structuredContent: structuredContentToJson(item.structuredContent),
          }
    ),
  })
  await logInventoryChange(tx, {
    productId,
    offerId: offer.id,
    merchantId,
    actorUserId,
    action: 'import',
    delta: analysis.itemsToImport.length,
    batchId: randomUUID(),
  })
  return {
    imported: analysis.itemsToImport.length,
    totalRows: analysis.totalRows,
    validRows: analysis.validRows,
    skippedEmptyRows: analysis.emptyRows,
    duplicateRows: analysis.duplicateRows,
    existingDuplicateRows: analysis.existingDuplicateRows,
  }
}

export async function importMyInventory(
  merchantId: number,
  actorUserId: number,
  productId: number,
  payload: InventoryImportPayload & { offerId?: number }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  try {
    const result = await prisma.$transaction(async tx => {
      // 旧兼容路径：未指定 offerId 时落到默认 Offer（单 SKU 无感）。
      const offer = await resolveMyOffer(tx, productId, payload.offerId)
      if (offer.deliveryMode !== 'instant_inventory') {
        throw badRequest('仅即时库存发货商品支持库存管理')
      }
      return confirmOfferInventoryImport(tx, productId, offer, merchantId, actorUserId, payload)
    })

    await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
    return result
  } catch (error) {
    // 预检与写入之间可能有另一笔导入提交。唯一索引是最终裁决，事务会完整回滚，
    // 再把该并发冲突转换成与普通重复输入一致的业务错误。
    if (isInventoryContentUniqueViolation(error)) {
      throw badRequest('库存导入包含重复项', [
        { field: 'items', message: 'existingDuplicateRows=concurrent' },
      ])
    }
    throw error
  }
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：库存导入显式 offerId。 */
export async function importMyOfferInventory(
  merchantId: number,
  actorUserId: number,
  productId: number,
  offerId: number,
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  try {
    const result = await prisma.$transaction(async tx => {
      const offer = await resolveMyOffer(tx, productId, offerId)
      if (offer.deliveryMode !== 'instant_inventory') {
        throw badRequest('仅即时库存发货商品支持库存管理')
      }
      return confirmOfferInventoryImport(tx, productId, offer, merchantId, actorUserId, payload)
    })

    await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
    return result
  } catch (error) {
    if (isInventoryContentUniqueViolation(error)) {
      throw badRequest('库存导入包含重复项', [
        { field: 'items', message: 'existingDuplicateRows=concurrent' },
      ])
    }
    throw error
  }
}

/**
 * 作废核心（T-CAT-BE-004）：只作废 available 项；updateMany 二次过滤 status 防与
 * 下单占用并发竞态。response 按 D-CAT-14/AC-CAT-008：availableStock 只统计目标 Offer，
 * productAvailableStock 为商品汇总；旧含混 stock 兼容窗口 = 目标 Offer 可售数（deprecated）。
 */
async function voidOfferInventory(
  tx: Prisma.TransactionClient,
  productId: number,
  offer: { id: number },
  merchantId: number | null,
  actorUserId: number,
  input: { count: number; reason?: string }
) {
  const candidates = await tx.inventoryItem.findMany({
    where: { productId, offerId: offer.id, status: 'available' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.count,
    select: { id: true },
  })
  if (candidates.length < input.count) {
    throw badRequest('可作废库存不足')
  }

  const voided = await tx.inventoryItem.updateMany({
    where: { id: { in: candidates.map(item => item.id) }, status: 'available' },
    data: { status: 'void' },
  })
  if (voided.count !== input.count) {
    throw badRequest('可作废库存不足')
  }

  const [availableStock, productAvailableStock] = await Promise.all([
    tx.inventoryItem.count({ where: { productId, offerId: offer.id, status: 'available' } }),
    tx.inventoryItem.count({ where: { productId, status: 'available' } }),
  ])

  await logInventoryChange(tx, {
    productId,
    offerId: offer.id,
    merchantId,
    actorUserId,
    action: 'void',
    delta: -input.count,
    reason: input.reason,
  })

  return {
    offerId: offer.id,
    voided: voided.count,
    availableStock,
    productAvailableStock,
    // 兼容窗口（D-CAT-14）：旧客户端读取 stock == 目标 Offer 可售数。
    stock: availableStock,
  }
}

export async function voidMyInventory(
  merchantId: number,
  actorUserId: number,
  productId: number,
  input: { count: number; reason?: string; offerId?: number }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  // 单事务完成：InventoryItem 置 void + InventoryLog 落账。
  const result = await prisma.$transaction(async tx => {
    // 旧兼容路径：未指定 offerId 时落到默认 Offer（单 SKU 无感）。
    const offer = await resolveMyOffer(tx, productId, input.offerId)
    if (offer.deliveryMode !== 'instant_inventory') {
      throw badRequest('仅即时库存发货商品支持库存管理')
    }
    return voidOfferInventory(tx, productId, offer, merchantId, actorUserId, input)
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：作废显式 offerId。 */
export async function voidMyOfferInventory(
  merchantId: number,
  actorUserId: number,
  productId: number,
  offerId: number,
  input: { count: number; reason?: string }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  const result = await prisma.$transaction(async tx => {
    const offer = await resolveMyOffer(tx, productId, offerId)
    if (offer.deliveryMode !== 'instant_inventory') {
      throw badRequest('仅即时库存发货商品支持库存管理')
    }
    return voidOfferInventory(tx, productId, offer, merchantId, actorUserId, input)
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

export async function listMyInventoryLogs(
  merchantId: number,
  productId: number,
  filters: { page?: number; pageSize?: number } = {}
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  const { page, pageSize } = await resolvePagination(filters.page, filters.pageSize)
  const where = { productId }
  const [total, logs] = await prisma.$transaction([
    prisma.inventoryLog.count({ where }),
    prisma.inventoryLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        productId: true,
        offerId: true,
        merchantId: true,
        actorUserId: true,
        action: true,
        delta: true,
        reason: true,
        orderId: true,
        batchId: true,
        createdAt: true,
      },
    }),
  ])

  return { items: logs, total, page, pageSize }
}
