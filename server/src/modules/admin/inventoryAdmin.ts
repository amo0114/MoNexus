import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { getDefaultOffer } from '../../lib/offers.js'
import { parseStoredDeliveryFields, structuredContentToJson } from '../../lib/deliveryFields.js'
import {
  analyzeInventoryForOffer,
  assertConfirmableInventoryAnalysis,
  isInventoryContentUniqueViolation,
  type InventoryImportPayload,
} from '../../lib/inventoryImport.js'
import { invalidateProductPublicCache } from '../products/cache.js'

/**
 * P4a F2：管理端导入的规格解析。显式 offerId 必须属于该商品且是即时库存
 * 规格；缺省先落默认 Offer，默认非即时库存时回退到唯一的即时库存规格
 * （零个 → 商品不支持库存导入；多个 → 无法猜测意图，要求显式指定）。
 */
type AdminInventoryClient = typeof prisma | Prisma.TransactionClient

async function resolveAdminImportOffer(
  tx: AdminInventoryClient,
  productId: number,
  offerId: number | undefined
) {
  if (offerId != null) {
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')
    if (offer.deliveryMode !== 'instant_inventory') {
      throw badRequest('仅即时库存发货规格支持库存导入')
    }
    return offer
  }
  const defaultOffer = await getDefaultOffer(tx, productId)
  if (defaultOffer.deliveryMode === 'instant_inventory') return defaultOffer
  const instantOffers = await tx.offer.findMany({
    where: { productId, deliveryMode: 'instant_inventory' },
    orderBy: { id: 'asc' },
    take: 2,
  })
  if (instantOffers.length === 0) throw badRequest('仅即时库存发货商品支持库存管理')
  if (instantOffers.length > 1) throw badRequest('该商品有多个即时库存规格，请指定 offerId')
  return instantOffers[0]
}

/**
 * Admin preview（D-CAT-15）：与商家共用 lib 领域分析器，返回一致统计/错误语义
 * （AC-CAT-009）。Preview 零业务写入。
 */
async function previewAdminOfferInventory(
  productId: number,
  offer: { id: number; deliveryFields: unknown },
  payload: InventoryImportPayload
) {
  const analysis = await analyzeInventoryForOffer(productId, offer, payload)
  if ('rowErrors' in analysis) {
    return {
      offerId: offer.id,
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
    offerId: offer.id,
    totalRows: analysis.totalRows,
    validRows: analysis.validRows,
    emptyRows: analysis.emptyRows,
    duplicateRows: analysis.duplicateRows,
    existingDuplicateRows: analysis.existingDuplicateRows,
    canImport: analysis.canImport,
  }
}

export async function previewInventory(
  productId: number,
  payload: InventoryImportPayload & { offerId?: number }
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')
  // 旧兼容路径：未指定 offerId 时按既有回退规则解析即时库存规格。
  const offer = await resolveAdminImportOffer(prisma, productId, payload.offerId)
  return previewAdminOfferInventory(productId, offer, payload)
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：admin preview 显式 offerId。 */
export async function previewOfferInventory(
  productId: number,
  offerId: number,
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')
  const offer = await resolveAdminImportOffer(prisma, productId, offerId)
  return previewAdminOfferInventory(productId, offer, payload)
}

/** confirm 事务内重算核心（Admin）：与商家共用分析器与确认校验；另写 AdminLog（D-CAT-15）。 */
async function confirmAdminOfferInventoryImport(
  tx: Prisma.TransactionClient,
  productId: number,
  offer: { id: number; deliveryFields: unknown },
  merchantId: number | null,
  adminUserId: number,
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
    actorUserId: adminUserId,
    action: 'import',
    delta: analysis.itemsToImport.length,
    batchId: randomUUID(),
  })

  await tx.adminLog.create({
    data: {
      adminUserId,
      action: '导入库存',
      targetType: 'product',
      targetId: productId,
      detail: `offerId=${offer.id}; 导入 ${analysis.itemsToImport.length} 条库存`,
    },
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

export async function importInventory(
  productId: number,
  payload: InventoryImportPayload & { offerId?: number },
  adminUserId: number
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')

  try {
    const result = await prisma.$transaction(async tx => {
      // 旧兼容路径：未指定 offerId 时按既有回退规则解析即时库存规格。
      const offer = await resolveAdminImportOffer(tx, productId, payload.offerId)
      return confirmAdminOfferInventoryImport(tx, productId, offer, product.merchantId, adminUserId, payload)
    })

    await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
    return result
  } catch (error) {
    // 与商家导入一样，数据库唯一索引是并发导入时的最终裁决；任何冲突
    // 都会使本事务完整回滚，并返回稳定的业务错误。
    if (isInventoryContentUniqueViolation(error)) {
      throw badRequest('库存导入包含重复项', [
        { field: 'items', message: 'existingDuplicateRows=concurrent' },
      ])
    }
    throw error
  }
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：admin 导入显式 offerId。 */
export async function importOfferInventory(
  productId: number,
  offerId: number,
  payload: InventoryImportPayload,
  adminUserId: number
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')

  try {
    const result = await prisma.$transaction(async tx => {
      const offer = await resolveAdminImportOffer(tx, productId, offerId)
      return confirmAdminOfferInventoryImport(tx, productId, offer, product.merchantId, adminUserId, payload)
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
