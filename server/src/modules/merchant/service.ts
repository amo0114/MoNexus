import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { badRequest, notFound, conflict, HttpError } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import {
  assertProductDeliveryConfiguration,
  normalizeProductImageFields,
} from '../../lib/productCommercial.js'
import {
  analyzeInventoryImport,
  analyzeStructuredInventoryImport,
  duplicateInventoryImportDetails,
  isInventoryContentUniqueViolation,
  type InventoryImportPayload,
} from '../../lib/inventoryImport.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import {
  createOrderStatusEvent,
  isInstantMode,
  normalizeOrderStatus,
  transitionOrderStatus,
  type FulfillmentOrderStatus,
} from '../orders/fulfillment.js'
import { releaseHeldOrder, settleHeldOrder } from '../orders/accounting.js'
import { applyRefundInventoryPolicy } from '../orders/refundInventory.js'
import { serializeMerchantOrder } from '../orders/serializers.js'
import { lockActiveWebhookConfigForShare } from './webhookConfig.js'
import type { MerchantOrderListQuery } from './schema.js'
import type { PurchaseFormField } from '../../lib/purchaseForm.js'
import {
  canonicalDeliveryText,
  parseStoredDeliveryFields,
  structuredContentToJson,
  validateDeliveryValues,
  type DeliveryField,
  type StructuredDeliveryContent,
} from '../../lib/deliveryFields.js'
import {
  createDefaultOffer,
  getDefaultOffer,
  syncProductProjection,
  serializePublicOffer,
} from '../../lib/offers.js'
import {
  normalizeFakaOfferIntegration,
  assertOfferProvisionMutex,
  onFakaOrderRefundedInTx,
} from '../../lib/fakaBridge/index.js'

// ---- Application ----

export async function applyForMerchant(
  userId: number,
  data: { name: string; description?: string; contactEmail?: string; contactPhone?: string }
) {
  const existing = await prisma.merchant.findUnique({ where: { userId } })
  if (existing) throw conflict('你已提交过商家申请')

  return prisma.merchant.create({
    data: {
      userId,
      name: data.name,
      description: data.description,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
    },
  })
}

// ---- Profile ----

export async function getMyMerchant(userId: number) {
  const merchant = await prisma.merchant.findUnique({
    where: { userId },
    include: { user: { select: { email: true } } },
  })
  if (!merchant) throw notFound('商家账户不存在')
  return merchant
}

export async function updateMyMerchant(
  userId: number,
  data: { name?: string; description?: string; contactEmail?: string; contactPhone?: string }
) {
  const merchant = await prisma.merchant.findUnique({ where: { userId } })
  if (!merchant) throw notFound('商家账户不存在')

  return prisma.merchant.update({ where: { userId }, data })
}

// ---- Products ----

const productListInclude = {
  _count: { select: { inventory: { where: { status: 'available' } } } },
  offers: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ProductInclude

type ProductWithAvailableStock = Prisma.ProductGetPayload<{ include: typeof productListInclude }>

export interface MerchantProductListFilters {
  page?: number
  pageSize?: number
  status?: string
  q?: string
  type?: string
  deliveryMode?: string
  lowStock?: boolean
}

async function resolvePagination(page?: number, pageSize?: number) {
  const [defaultPageSize, maxPageSize] = await Promise.all([
    getSystemConfigValue('defaultPageSize'),
    getSystemConfigValue('maxPageSize'),
  ])
  const safeDefaultPageSize = defaultPageSize > 0 ? defaultPageSize : businessRegistry.pagination.defaultPageSize
  const safeMaxPageSize = maxPageSize > 0 ? maxPageSize : businessRegistry.pagination.maxPageSize
  const resolvedPage = page && page > 0 ? page : 1
  const requestedPageSize = pageSize && pageSize > 0 ? pageSize : safeDefaultPageSize

  return {
    page: resolvedPage,
    pageSize: Math.min(requestedPageSize, safeMaxPageSize),
  }
}

function buildProductWhere(merchantId: number, filters: MerchantProductListFilters): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = { merchantId }

  if (filters.status) where.status = filters.status
  if (filters.type) where.type = filters.type
  if (filters.deliveryMode) where.deliveryMode = filters.deliveryMode
  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: Prisma.QueryMode.insensitive } },
      { description: { contains: filters.q, mode: Prisma.QueryMode.insensitive } },
      { type: { contains: filters.q, mode: Prisma.QueryMode.insensitive } },
    ]
  }

  return where
}

function isLowStockProduct(product: ProductWithAvailableStock, threshold: number) {
  if (product.stockMode !== 'limited') return false
  if (product.deliveryMode === 'instant_inventory') return product._count.inventory <= threshold
  if (product.deliveryMode === 'instant_fixed') return product.stock <= threshold
  return false // manual_service 不参与低库存提醒
}

function serializeMerchantProduct(product: ProductWithAvailableStock, lowStockThreshold: number) {
  const availableStock = product._count.inventory
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    richDescription: product.richDescription,
    type: product.type,
    icon: product.icon,
    imageUrl: product.imageUrl,
    images: product.images,
    price: product.price,
    originalPrice: product.originalPrice,
    // 即时库存以 InventoryItem.status=available 为唯一运行时来源；
    // Product.stock 仅供固定内容/人工服务的限量额度使用。
    stock: product.deliveryMode === 'instant_inventory' ? availableStock : product.stock,
    availableStock,
    sales: product.sales,
    isHot: product.isHot,
    status: product.status,
    deliveryMode: product.deliveryMode,
    stockMode: product.stockMode,
    fixedContent: product.fixedContent,
    fixedContentType: product.fixedContentType,
    purchaseForm: product.purchaseForm ?? [],
    // P4a：商家端返回完整 Offer 列表（含 fixedContent——商家本就可见自己商品
    // 的交付配置）；公开接口走 serializePublicOffer 剥离。
    offers: product.offers,
    merchantId: product.merchantId,
    createdAt: product.createdAt,
    lowStock: isLowStockProduct(product, lowStockThreshold),
  }
}

export async function listMyProducts(merchantId: number, filters: MerchantProductListFilters = {}) {
  const { page, pageSize } = await resolvePagination(filters.page, filters.pageSize)
  const lowStockThreshold = await getSystemConfigValue('lowStockThreshold')
  const where = buildProductWhere(merchantId, filters)
  const orderBy = { createdAt: 'desc' } as const

  if (typeof filters.lowStock === 'boolean') {
    const products = await prisma.product.findMany({
      where,
      include: productListInclude,
      orderBy,
    })
    const filtered = products
      .filter(product => isLowStockProduct(product, lowStockThreshold) === filters.lowStock)
      .map(product => serializeMerchantProduct(product, lowStockThreshold))

    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
    }
  }

  const [total, products] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: productListInclude,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return {
    items: products.map(product => serializeMerchantProduct(product, lowStockThreshold)),
    total,
    page,
    pageSize,
  }
}

export async function previewMyInventoryImport(
  merchantId: number,
  productId: number,
  payload: InventoryImportPayload & { offerId?: number }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')
  // P4a/P4b：门禁与模板都在 Offer 上；未指定 offerId 落到默认 Offer（单 SKU 无感）。
  const offer = payload.offerId != null
    ? await prisma.offer.findFirst({ where: { id: payload.offerId, productId } })
    : await getDefaultOffer(prisma, productId)
  if (!offer) throw notFound('规格不存在')
  if (offer.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }

  const deliveryFields = parseStoredDeliveryFields(offer.deliveryFields)
  if (deliveryFields.length > 0) {
    const analysis = await analyzeStructuredInventoryImport(productId, payload, deliveryFields)
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
        fields: deliveryFields,
        rows: analysis.itemsToImport.slice(0, 20).map(item => item.structuredContent.values),
      },
    }
  }

  const analysis = await analyzeInventoryImport(productId, payload)
  return {
    totalRows: analysis.totalRows,
    validRows: analysis.validRows,
    emptyRows: analysis.emptyRows,
    duplicateRows: analysis.duplicateRows,
    existingDuplicateRows: analysis.existingDuplicateRows,
    canImport: analysis.canImport,
  }
}

function assertOriginalPriceAtLeastSale(price: number, originalPrice: number | null | undefined) {
  if (originalPrice != null && originalPrice < price) {
    throw badRequest('原价不能低于售价')
  }
}

export async function createMyProduct(
  merchantId: number,
  data: {
    name: string; description?: string; richDescription?: string;
    type: string; icon?: string; imageUrl?: string | null; images?: string[];
    price: number; originalPrice?: number; isHot?: boolean; deliveryMode?: string;
    stockMode?: string; stock?: number; fixedContent?: string; fixedContentType?: string;
    purchaseForm?: PurchaseFormField[];
    // P4a F3：向导原子发布——默认规格名 + 额外规格与商品同事务落库。
    primaryOfferName?: string;
    // 复审 P2-2：默认规格的订阅有效期（落 Offer，不进 Product 列）。
    validityDays?: number | null;
    offers?: (OfferWriteInput & { name: string; price: number })[]
  }
) {
  assertOriginalPriceAtLeastSale(data.price, data.originalPrice)
  // primaryOfferName/validityDays/offers 只进 Offer 表，不进 Product 列。
  const { primaryOfferName: _primaryOfferName, validityDays: _validityDays, offers: _offers, ...productFields } = data
  const normalizedProductData = normalizeProductImageFields(productFields)
  const deliveryMode = data.deliveryMode ?? 'instant_inventory'
  const stockMode = data.stockMode ?? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
  const fixedContentType = data.fixedContentType ?? 'text'

  assertProductDeliveryConfiguration({
    deliveryMode,
    stockMode,
    incomingStock: data.stock,
    effectiveStock: data.stock,
    fixedContent: data.fixedContent,
    fixedContentType,
  })

  const product = await prisma.$transaction(async tx => {
    const created = await tx.product.create({
      data: {
        ...normalizedProductData,
        deliveryMode,
        stockMode,
        fixedContentType,
        stock: deliveryMode === 'instant_inventory' ? 0 : (data.stock ?? 0),
        merchantId,
      },
    })
    // P4a：Offer 是价格/履约配置真相源，商品创建时同事务生成默认 Offer。
    await createDefaultOffer(tx, created.id, {
      price: data.price,
      originalPrice: data.originalPrice ?? null,
      deliveryMode,
      stockMode,
      stock: deliveryMode === 'instant_inventory' ? 0 : (data.stock ?? 0),
      fixedContent: data.fixedContent ?? null,
      fixedContentType,
      validityDays: data.validityDays ?? null,
    }, data.primaryOfferName)
    // F3：额外规格同事务创建，任一条校验失败 → 整体回滚（无孤儿商品）。
    for (const offerInput of data.offers ?? []) {
      await insertOffer(tx, merchantId, created.id, offerInput)
    }
    if (data.offers?.length) {
      await syncProductProjection(tx, created.id)
      // 投影（最低价/库存合计）可能已被额外规格改写，返回同步后的行。
      return tx.product.findUniqueOrThrow({ where: { id: created.id } })
    }
    return created
  })

  await invalidateProductPublicCache(product.id, { list: true })
  return product
}

export async function updateMyProduct(merchantId: number, productId: number, data: Record<string, unknown>) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId } })
  if (!product) throw notFound('商品不存在')

  const nextPrice = typeof data.price === 'number' ? data.price : product.price
  const nextOriginalPrice = 'originalPrice' in data
    ? data.originalPrice as number | null
    : product.originalPrice
  assertOriginalPriceAtLeastSale(nextPrice, nextOriginalPrice)
  const normalizedProductData = normalizeProductImageFields(
    data as Record<string, unknown> & { imageUrl?: string | null; images?: string[] },
    product.images
  )

  const deliveryMode = (normalizedProductData.deliveryMode as string | undefined) ?? product.deliveryMode
  if (deliveryMode !== product.deliveryMode) {
    const [inventoryCount, orderCount] = await prisma.$transaction([
      prisma.inventoryItem.count({ where: { productId } }),
      prisma.order.count({ where: { productId } }),
    ])
    if (inventoryCount > 0 || orderCount > 0) {
      throw badRequest('商品已有库存记录或订单，不能修改履约模式')
    }
  }
  const stockMode = (normalizedProductData.stockMode as string | undefined)
    ?? (normalizedProductData.deliveryMode && deliveryMode !== product.deliveryMode
      ? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
      : product.stockMode)
  const incomingStock = typeof normalizedProductData.stock === 'number' ? normalizedProductData.stock : undefined

  // 商家切换交付模式但未显式清空旧 fixedContent 时给出引导性报错，避免「仅固定内容交付支持 fixedContent」造成困惑
  if (!('fixedContent' in normalizedProductData) && product.fixedContent != null && deliveryMode !== 'instant_fixed') {
    throw badRequest('切换交付模式请同时将 fixedContent 置空（传 null）')
  }

  // P5：file 形态的交付配置只能走规格管理——商品级 API 面上没有 fixedFileId，
  // 商品级改交付模式/固定内容会把默认规格推向违反 file 不变量的状态。
  // 名称/价格/图片/名额等其余编辑不受影响。
  const isFileFormProjection = product.fixedContentType === 'file'
  if (isFileFormProjection && (
    normalizedProductData.deliveryMode != null
    || 'fixedContent' in normalizedProductData
    || normalizedProductData.fixedContentType != null
  )) {
    throw badRequest('文件交付规格的交付配置请在「规格管理」中修改')
  }
  const fileFormDefaultOffer = isFileFormProjection ? await getDefaultOffer(prisma, productId) : null

  assertProductDeliveryConfiguration({
    deliveryMode,
    stockMode,
    incomingStock,
    effectiveStock: incomingStock ?? product.stock,
    fixedContent: 'fixedContent' in normalizedProductData
      ? (normalizedProductData.fixedContent as string | null)
      : product.fixedContent,
    fixedContentType: (normalizedProductData.fixedContentType as string | undefined) ?? product.fixedContentType,
    fixedFileId: fileFormDefaultOffer?.fixedFileId ?? null,
    allowFileForm: isFileFormProjection,
  })

  // P4a：商品级编辑作用于默认 Offer（真相源），Product 商业列由投影同步对齐。
  // 多 SKU 商品的其余规格不受商品级编辑影响，仅能通过 Offer 接口修改。
  const switchedToInstantInventory =
    deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
  const updated = await prisma.$transaction(async tx => {
    await tx.product.update({
      where: { id: productId },
      data: {
        ...normalizedProductData,
        deliveryMode,
        stockMode,
        // 新建/无业务记录商品切到即时库存时，遗留的额度字段不再代表库存。
        ...(switchedToInstantInventory ? { stock: 0 } : {}),
      },
    })
    const defaultOffer = await getDefaultOffer(tx, productId)
    await tx.offer.update({
      where: { id: defaultOffer.id },
      data: {
        ...(typeof data.price === 'number' ? { price: data.price } : {}),
        ...('originalPrice' in data ? { originalPrice: data.originalPrice as number | null } : {}),
        deliveryMode,
        stockMode,
        ...('fixedContent' in normalizedProductData
          ? { fixedContent: normalizedProductData.fixedContent as string | null }
          : {}),
        ...(normalizedProductData.fixedContentType != null
          ? { fixedContentType: normalizedProductData.fixedContentType as string }
          : {}),
        ...(incomingStock !== undefined ? { stock: incomingStock } : {}),
        ...(switchedToInstantInventory ? { stock: 0 } : {}),
      },
    })
    await syncProductProjection(tx, productId)
    return tx.product.findUniqueOrThrow({ where: { id: productId } })
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return updated
}

/**
 * Adjust the numeric availability of limited fixed-content/manual products.
 * Unlike instant inventory, these products do not have one secret per buyer;
 * Product.stock therefore means remaining sale/service capacity.  A
 * conditional decrement keeps concurrent reductions from going below zero.
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
    // P4a：名额挂在 Offer 上；未指定 offerId 时落到默认 Offer（单 SKU 无感）。
    const offer = input.offerId != null
      ? await tx.offer.findFirst({ where: { id: input.offerId, productId } })
      : await getDefaultOffer(tx, productId)
    if (!offer) throw notFound('规格不存在')
    if (offer.deliveryMode === 'instant_inventory') {
      throw badRequest('即时库存商品请通过交付库存导入或作废管理')
    }
    if (offer.stockMode !== 'limited') {
      throw badRequest('不限量商品无需调整可售名额')
    }

    if (input.delta > 0) {
      const updated = await tx.offer.updateMany({
        where: {
          id: offer.id,
          stockMode: 'limited',
          deliveryMode: { not: 'instant_inventory' },
        },
        data: { stock: { increment: input.delta } },
      })
      if (updated.count !== 1) throw badRequest('商品库存模式已变更，请刷新后重试')
    } else {
      const updated = await tx.offer.updateMany({
        where: {
          id: offer.id,
          stockMode: 'limited',
          deliveryMode: { not: 'instant_inventory' },
          stock: { gte: -input.delta },
        },
        data: { stock: { decrement: -input.delta } },
      })
      if (updated.count !== 1) throw badRequest('减少数量不能超过当前可售名额')
    }

    await syncProductProjection(tx, productId)
    const updatedOffer = await tx.offer.findUniqueOrThrow({
      where: { id: offer.id },
      select: { stock: true },
    })
    await logInventoryChange(tx, {
      productId,
      offerId: offer.id,
      merchantId,
      actorUserId,
      action: 'capacity_adjust',
      delta: input.delta,
      reason: input.reason,
    })
    return { stock: updatedOffer.stock }
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
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
      // P4a：库存归属 Offer；未指定 offerId 时落到默认 Offer（单 SKU 无感）。
      const offer = payload.offerId != null
        ? await tx.offer.findFirst({ where: { id: payload.offerId, productId } })
        : await getDefaultOffer(tx, productId)
      if (!offer) throw notFound('规格不存在')
      if (offer.deliveryMode !== 'instant_inventory') {
        throw badRequest('仅即时库存发货商品支持库存管理')
      }

      // P4b：规格带交付字段模板时走结构化导入——行按 | 分隔映射字段，
      // 规范化文本写入 content（唯一约束与领取 SQL 的权威形态不变）。
      const deliveryFields = parseStoredDeliveryFields(offer.deliveryFields)
      const analysis = deliveryFields.length > 0
        ? await analyzeStructuredInventoryImport(productId, payload, deliveryFields, tx)
        : await analyzeInventoryImport(productId, payload, tx)
      if ('rowErrors' in analysis && analysis.rowErrors.length > 0) {
        throw badRequest(
          '部分行不符合交付字段模板，请先预览修正',
          analysis.rowErrors.map(err => ({ field: 'items', message: `第 ${err.row} 行：${err.message}` }))
        )
      }
      if (analysis.duplicateRows > 0 || analysis.existingDuplicateRows > 0) {
        throw badRequest('库存导入包含重复项', duplicateInventoryImportDetails(analysis))
      }
      if (analysis.validRows === 0) {
        throw badRequest('至少提供一条有效库存')
      }

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

export async function voidMyInventory(
  merchantId: number,
  actorUserId: number,
  productId: number,
  input: { count: number; reason?: string; offerId?: number }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  // 单事务完成：InventoryItem 置 void + InventoryLog 落账。
  // 只允许作废 available 项；updateMany 二次过滤 status 防与下单占用并发竞态。
  const result = await prisma.$transaction(async tx => {
    const offer = input.offerId != null
      ? await tx.offer.findFirst({ where: { id: input.offerId, productId } })
      : await getDefaultOffer(tx, productId)
    if (!offer) throw notFound('规格不存在')
    if (offer.deliveryMode !== 'instant_inventory') {
      throw badRequest('仅即时库存发货商品支持库存管理')
    }

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

    const availableStock = await tx.inventoryItem.count({ where: { productId, status: 'available' } })

    await logInventoryChange(tx, {
      productId,
      offerId: offer.id,
      merchantId,
      actorUserId,
      action: 'void',
      delta: -input.count,
      reason: input.reason,
    })

    return { voided: voided.count, stock: availableStock, availableStock }
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

// ---- Orders ----

function endOfDate(date: string) {
  const end = new Date(`${date}T00:00:00.000Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return end
}

function getDateRange(query: MerchantOrderListQuery) {
  if (!query.dateFrom && !query.dateTo) return undefined

  return {
    ...(query.dateFrom ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
    ...(query.dateTo ? { lt: endOfDate(query.dateTo) } : {}),
  }
}

function getOrderStatusWhere(status?: FulfillmentOrderStatus) {
  if (!status) return undefined
  return status === 'delivered' ? { in: ['delivered', 'completed'] } : status
}

function buildOrderWhere(merchantId: number, query: MerchantOrderListQuery): Prisma.OrderWhereInput {
  return {
    merchantId,
    ...(query.status ? { status: getOrderStatusWhere(query.status) } : {}),
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.dateFrom || query.dateTo ? { createdAt: getDateRange(query) } : {}),
    ...(query.q
      ? {
          OR: [
            { product: { name: { contains: query.q, mode: 'insensitive' } } },
            { user: { email: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }
}

function getOrderDeliveryMode(order: {
  deliveryModeSnapshot?: string | null
  product?: { deliveryMode?: string | null } | null
}) {
  // 迁移前的历史订单在快照字段为空时仍按原商品模式工作；新订单始终使用快照。
  return order.deliveryModeSnapshot ?? order.product?.deliveryMode
}

function getAvailableActions(order: {
  status: string
  deliveryModeSnapshot?: string | null
  product?: { deliveryMode?: string | null } | null
}) {
  const status = normalizeOrderStatus(order.status)
  const deliveryMode = getOrderDeliveryMode(order)

  // pending 状态下商家可接单（start_fulfillment）或拒单（reject）；
  // 拒单只对 manual_service 有意义，但即时模式创建即 delivered 不会进入 pending
  if (status === 'pending') return ['start_fulfillment', 'reject']
  // P6b：履约中的人工服务单可交付，也可发进度更新（post_progress 不改状态）
  if (status === 'processing' && deliveryMode === 'manual_service') return ['deliver', 'post_progress']
  if (status === 'disputed') return ['respond_dispute']
  return []
}

function computeSlaExceeded(order: {
  status?: string
  fulfillmentDeadline?: Date | null
}): boolean {
  if (!order.fulfillmentDeadline) return false
  const status = order.status ? normalizeOrderStatus(order.status) : null
  if (status !== 'pending' && status !== 'processing') return false
  return order.fulfillmentDeadline.getTime() < Date.now()
}

export function getSettlementEligibility(orderStatus: string) {
  const status = normalizeOrderStatus(orderStatus)

  if (status === 'delivered' || status === 'closed') {
    return { payable: true, blockReason: null }
  }

  const blockReasons: Record<string, string> = {
    pending: '订单待处理，暂不可结算',
    processing: '订单履约中，暂不可结算',
    disputed: '订单争议中，暂不可结算',
    refunded: '订单已退款，不可结算',
  }

  return {
    payable: false,
    blockReason: blockReasons[status] ?? '订单状态不可结算',
  }
}

export async function listMyOrders(merchantId: number, query: MerchantOrderListQuery) {
  const where = buildOrderWhere(merchantId, query)
  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, email: true } },
        product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true, deliveryMode: true } },
        delivery: { select: { status: true, publicNote: true, deliveredAt: true } },
        settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
        // P7b：任务态徽标（开通中/已自动交付/已降级人工 + 脱敏诊断码）。
        provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
      },
      // P6c：sort=booking 时预约日期升序（最近的预约最先处理），无预约单
      // （bookingDate=null）排后并沿用默认时间倒序；命中 (merchantId, bookingDate) 索引。
      orderBy: query.sort === 'booking'
        ? [{ bookingDate: { sort: 'asc', nulls: 'last' } as const }, { createdAt: 'desc' as const }]
        : { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.order.count({ where }),
  ])

  return {
    items: items.map(order => ({
      ...serializeMerchantOrder(order),
      holdingPoints: order.holdingPoints,
      fulfillmentDeadline: order.fulfillmentDeadline,
      // P6c：预约日期（null = 非预约单）；列表/详情均透出供商家排期。
      bookingDate: order.bookingDate,
      slaExceeded: computeSlaExceeded(order),
      availableActions: getAvailableActions(order),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

export async function getMyOrderDetail(merchantId: number, orderId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true, deliveryMode: true } },
      delivery: {
        select: {
          status: true, publicNote: true, deliveredAt: true,
          // P6a：订阅到期时刻。商家视角只展示、永不遮蔽（履约凭据）。
          expiresAt: true,
          // P5：附件元数据（商家核对已交付文件）；content 本体照旧不进商家详情。
          file: { select: { fileName: true, size: true, status: true } },
        },
      },
      settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
      // P7b：任务态透出 + 脱敏诊断码，供商家判断是否人工介入。
      provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
      statusEvents: {
        select: {
          id: true,
          actorRole: true,
          fromStatus: true,
          toStatus: true,
          action: true,
          publicNote: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!order) throw notFound('订单不存在')
  return {
    ...serializeMerchantOrder(order),
    holdingPoints: order.holdingPoints,
    fulfillmentDeadline: order.fulfillmentDeadline,
    // P6c：预约日期（null = 非预约单）。
    bookingDate: order.bookingDate,
    slaExceeded: computeSlaExceeded(order),
    availableActions: getAvailableActions(order),
    // 详情显式回填：买家购买前填写的信息是商家的履约依据。
    purchaseFormSnapshot: order.purchaseFormSnapshot ?? null,
    purchaseFormAnswers: order.purchaseFormAnswers ?? null,
  }
}

async function assertMerchantOrder(merchantId: number, orderId: number, tx: Prisma.TransactionClient) {
  const order = await tx.order.findFirst({
    where: { id: orderId, merchantId },
    select: {
      id: true,
      status: true,
      userId: true,
      holdingPoints: true,
      fundsHeld: true,
      deliveryModeSnapshot: true,
      offerId: true,
      deliveryFieldsSnapshot: true,
      product: { select: { deliveryMode: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return order
}

export async function startOrderFulfillment(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { publicNote?: string; internalNote?: string }
) {
  await prisma.$transaction(async tx => {
    await assertMerchantOrder(merchantId, orderId, tx)
    await transitionOrderStatus({
      orderId,
      toStatus: 'processing',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.start',
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)
  })

  return getMyOrderDetail(merchantId, orderId)
}

export async function deliverOrderFulfillment(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: {
    deliveryContent?: string
    /** P4b：按规格模板交付的字段值；与 deliveryContent 二选一。 */
    structuredValues?: Record<string, string>
    /** P5：交付附件（先经交付文件上传获得）；可与文本/结构化并存。 */
    attachmentFileId?: number
    publicNote?: string
    internalNote?: string
  }
) {
  await prisma.$transaction(async tx => {
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    if (getOrderDeliveryMode(order) !== 'manual_service') {
      throw badRequest('只有人工服务订单可由商家履约交付')
    }
    // P5：附件必须是本商家上传且可用的文件（别家 404 防枚举，吊销 400）。
    if (input.attachmentFileId != null) {
      await assertMyDeliveryFile(tx, merchantId, input.attachmentFileId)
    }

    // P4b：按订单的模板快照（下单时冻结，商家改模板不影响本单契约）强制分支：
    // - 有模板：必须提交完整 structuredValues，拒绝纯文本与空对象——否则商家
    //   可绕过 API 把必填模板订单标记为已发货且交付内容为空；
    // - 无模板：必须提交非空 deliveryContent，拒绝结构化字段；
    // - 二者同时提交拒绝（意图不明确，宁可让调用方改正）。
    const fields = parseStoredDeliveryFields(order.deliveryFieldsSnapshot)
    const hasStructured = input.structuredValues != null && Object.keys(input.structuredValues).length > 0
    const hasText = (input.deliveryContent ?? '').trim().length > 0
    if (hasStructured && hasText) {
      throw badRequest('结构化字段与纯文本发货内容只能提交其一')
    }
    let deliveryContent = input.deliveryContent
    let deliveryStructuredContent: StructuredDeliveryContent | null = null
    if (fields.length > 0) {
      if (!hasStructured) throw badRequest('该订单需按交付字段模板逐项发货')
      const values = validateDeliveryValues(fields, input.structuredValues)
      deliveryContent = canonicalDeliveryText(fields, values)
      deliveryStructuredContent = { fields, values }
    } else {
      if (hasStructured) throw badRequest('该订单为纯文本交付，请提交发货内容')
      // P5：附件本身就是合法交付物——纯文本内容与附件至少其一。
      if (!hasText && input.attachmentFileId == null) throw badRequest('发货内容不能为空')
    }

    await transitionOrderStatus({
      orderId,
      toStatus: 'delivered',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.deliver',
      deliveryContent,
      deliveryStructuredContent,
      deliveryFileId: input.attachmentFileId ?? null,
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)

  })

  return getMyOrderDetail(merchantId, orderId)
}

// P6b：单订单每小时最多 6 条进度更新（审计表即计数器）。
// P7a 复核：复审 P2-4 的订单行 FOR UPDATE（下方）已把 count→create 整体
// 串行化——READ COMMITTED 下取到锁后的语句可见先行事务提交的事件，计数
// 不会超发，且这是 DB 行锁，跨实例同样成立。并发回归见
// __tests__/p7a-multi-instance.test.ts。
const PROGRESS_RATE_LIMIT = 6
const PROGRESS_RATE_WINDOW_MS = 60 * 60 * 1000

/**
 * P6b：商家发布履约进度。仅写 OrderStatusEvent（fromStatus=toStatus='processing'），
 * 不改 order.status——决策 ③：进度不引入新订单状态。note 即买家时间线上的
 * publicNote。
 */
export async function postOrderProgress(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { note: string }
) {
  await prisma.$transaction(async tx => {
    // 归属校验沿用统一入口：他人/不存在的订单一律 404 防枚举。
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    // 复审 P2-4：先锁订单行再终检状态。进度写入与交付并发时，进度事务在
    // 旧快照上看到 processing、提交时订单已 delivered——买家时间线会出现
    // 交付之后的 processing→processing 事件。FOR UPDATE 与
    // transitionOrderStatus 的行更新互斥：交付先提交则此处重读拒绝，
    // 进度先拿锁则交付排队在其后，事件序保持正确。
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    })
    if (
      normalizeOrderStatus(fresh.status) !== 'processing'
      || getOrderDeliveryMode(order) !== 'manual_service'
    ) {
      throw badRequest('仅履约中的人工服务订单可更新进度')
    }

    const recent = await tx.orderStatusEvent.count({
      where: {
        orderId: order.id,
        action: 'merchant.progress',
        createdAt: { gte: new Date(Date.now() - PROGRESS_RATE_WINDOW_MS) },
      },
    })
    if (recent >= PROGRESS_RATE_LIMIT) {
      throw new HttpError(429, 'PROGRESS_RATE_LIMITED', '进度更新过于频繁，请稍后再试')
    }

    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId,
      actorRole: 'merchant',
      fromStatus: 'processing',
      toStatus: 'processing',
      action: 'merchant.progress',
      publicNote: input.note,
    })
  })

  return { ok: true }
}

export async function respondToOrderDispute(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { resolution: 'resume' | 'close'; publicNote?: string; internalNote?: string }
) {
  await prisma.$transaction(async tx => {
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    // 即时模式（instant_*）内容已交付，恢复履约直接回到 delivered；人工服务单回 processing 由商家重新交付
    const resumeTarget: FulfillmentOrderStatus =
      isInstantMode(getOrderDeliveryMode(order) ?? '') ? 'delivered' : 'processing'
    await transitionOrderStatus({
      orderId,
      toStatus: input.resolution === 'resume' ? resumeTarget : 'closed',
      actorRole: 'merchant',
      actorUserId,
      action: `merchant.dispute.${input.resolution}`,
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)

    // 商家对人工服务争议选择关闭时，和用户确认关闭、管理员裁决关闭
    // 使用同一资金结算路径。此前这里只改订单状态，会遗留冻结积分和 holding Settlement。
    if (input.resolution === 'close') {
      await settleHeldOrder(tx, order, `商家争议关闭扣款: #${order.id}`)
      await tx.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date() },
      })
    }
  })

  return getMyOrderDetail(merchantId, orderId)
}

export async function rejectOrder(
  merchantId: number,
  actorUserId: number,
  orderId: number,
  input: { publicNote?: string; internalNote?: string }
) {
  // 商家拒单（pending → refunded）：仅 manual_service 走 pending；即时模式创建即 delivered 不会进入 pending。
  // 拒单后立即退还冻结积分（holdingPoints），Settlement holding → voided。
  await prisma.$transaction(async tx => {
    const order = await tx.order.findFirst({
      where: { id: orderId, merchantId },
      select: {
        id: true,
        status: true,
        userId: true,
        holdingPoints: true,
        fundsHeld: true,
        deliveryModeSnapshot: true,
        // P5.5 T4：退款回补策略需要的归属字段。
        productId: true,
        offerId: true,
        merchantId: true,
        product: { select: { deliveryMode: true } },
      },
    })
    if (!order) throw notFound('订单不存在')

    if (getOrderDeliveryMode(order) !== 'manual_service') {
      throw badRequest('仅人工服务订单可拒单')
    }

    // 状态流转：pending → refunded（由 transitionOrderStatus 校验合法性）
    await transitionOrderStatus({
      orderId,
      toStatus: 'refunded',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.reject',
      publicNote: input.publicNote ?? '商家拒绝接单，积分已退还',
      internalNote: input.internalNote,
    }, tx)

    await releaseHeldOrder(tx, order, `商家拒单释放冻结积分: #${order.id}`)

    // P5.5 T4：拒单退款的库存侧效果与积分退还同事务——未交付（pending），
    // 限量规格回补服务名额，销量净减。
    await applyRefundInventoryPolicy(tx, order, {
      fromStatus: 'pending',
      actorUserId,
    })

    // FakaBridge：拒单时取消尚未开通的任务（避免退款后仍外呼开通）
    await onFakaOrderRefundedInTx(tx, orderId)
  })

  return getMyOrderDetail(merchantId, orderId)
}

// ---- Settlements ----

export async function listMySettlements(merchantId: number, page = 1, pageSize = 20) {
  const settlements = await prisma.settlement.findMany({
    where: { merchantId },
    include: {
      order: {
        select: { id: true, price: true, status: true, createdAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })

  return settlements.map(settlement => ({
    ...settlement,
    ...getSettlementEligibility(settlement.order.status),
  }))
}

// ---- Stats ----

export async function getMyStats(merchantId: number) {
  const now = new Date()
  const [productCount, orderCount, revenueResult, pendingSettlement, pendingCount, processingCount, slaExceeded] =
    await Promise.all([
      prisma.product.count({ where: { merchantId } }),
      prisma.order.count({ where: { merchantId } }),
      prisma.settlement.aggregate({
        where: { merchantId },
        _sum: { settlementAmount: true },
      }),
      prisma.settlement.aggregate({
        where: { merchantId, status: 'pending' },
        _sum: { settlementAmount: true },
      }),
      prisma.order.count({ where: { merchantId, status: 'pending' } }),
      prisma.order.count({ where: { merchantId, status: 'processing' } }),
      prisma.order.count({
        where: {
          merchantId,
          status: { in: ['pending', 'processing'] },
          fulfillmentDeadline: { lt: now },
        },
      }),
    ])

  return {
    productCount,
    orderCount,
    totalRevenue: revenueResult._sum.settlementAmount ?? 0,
    pendingSettlement: pendingSettlement._sum.settlementAmount ?? 0,
    todo: {
      pending: pendingCount,
      processing: processingCount,
      slaExceeded,
    },
  }
}

// ---- Offers (P4a: SKU 管理) ----

type OfferWriteInput = {
  name?: string
  price?: number
  originalPrice?: number | null
  status?: string
  deliveryMode?: string
  stockMode?: string
  stock?: number
  fixedContent?: string | null
  fixedContentType?: string
  // P5：file 形态挂载的交付文件；null 清空（配合切回 text/url）。
  fixedFileId?: number | null
  sortOrder?: number
  // P6a：订阅有效期天数；null = 永久。
  validityDays?: number | null
  // P4b：交付字段模板；null 清空回纯文本。已过 zod（deliveryFieldsSchema）。
  deliveryFields?: DeliveryField[] | null
  // P7b：自动开通开关。仅 manual_service 且无模板且商家已有 active webhook
  // 配置可为 true（服务端校验 + DB CHECK 兜底，硬验收 ④⑤）。
  // 与 FakaBridge externalIntegration 互斥。
  autoProvision?: boolean
  // FakaBridge：null 关闭；'faka_bridge' + externalSku 开通 Xboard。
  externalIntegration?: string | null
  externalSku?: string | null
  // 设为默认规格（仅接受 true，事务内从原默认转移；不接受 false——
  // 取消默认必须通过在另一条上设默认完成，保证不变量恒成立）。
  isDefault?: boolean
}

/**
 * P7b：autoProvision 开启前置校验（硬验收 ④⑤）：人工服务 + 无交付模板 +
 * 商家已有 active webhook 配置。DB CHECK 兜底前两条；active 配置是业务
 * 前置（下单事务要冻结它，缺失时买家下单会 409 安全失败）。
 * FOR SHARE 锁 active 行（复审 P1 线性化）：与撤销的 FOR UPDATE 互斥——
 * 撤销先提交则此处查无 active 行、开启被拒；本事务先提交则撤销的关开关
 * 扫描必然覆盖刚开启的规格，不存在「开关开着但配置已撤销」的静默错配。
 */
async function assertAutoProvisionAllowed(
  tx: Prisma.TransactionClient,
  merchantId: number,
  autoProvision: boolean,
  deliveryMode: string,
  deliveryFields: readonly unknown[] | null | undefined
) {
  if (!autoProvision) return
  if (deliveryMode !== 'manual_service') {
    throw badRequest('自动开通仅支持人工服务规格')
  }
  if ((deliveryFields?.length ?? 0) > 0) {
    throw badRequest('带交付字段模板的规格暂不支持自动开通')
  }
  const active = await lockActiveWebhookConfigForShare(tx, merchantId)
  if (!active) {
    throw badRequest('请先在商家设置中配置自动开通 webhook，再开启该开关')
  }
}

/** instant_fixed 固定内容天然单值，不支持交付字段模板（P4b 决策点 2）。 */
function assertDeliveryFieldsAllowed(deliveryMode: string, deliveryFields: DeliveryField[] | null | undefined) {
  if (deliveryFields && deliveryFields.length > 0 && deliveryMode === 'instant_fixed') {
    throw badRequest('固定内容交付不支持交付字段模板')
  }
}

async function assertMyProduct(merchantId: number, productId: number) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')
}

function assertOfferCommercialInput(input: {
  price: number
  originalPrice?: number | null
  deliveryMode: string
  stockMode: string
  // 本次请求显式携带的库存(未改动时为 undefined);即时库存模式下"设置库存"
  // 会被拒绝,故不能把持久化的 offer.stock 塞进来误判。
  incomingStock?: number
  // 合并请求与库存后的有效容量,供 limited 模式非负校验。
  effectiveStock?: number
  fixedContent?: string | null
  fixedContentType: string
  fixedFileId?: number | null
}) {
  assertOriginalPriceAtLeastSale(input.price, input.originalPrice ?? null)
  assertProductDeliveryConfiguration({
    deliveryMode: input.deliveryMode,
    stockMode: input.stockMode,
    incomingStock: input.incomingStock,
    effectiveStock: input.effectiveStock,
    fixedContent: input.fixedContent ?? undefined,
    fixedContentType: input.fixedContentType,
    fixedFileId: input.fixedFileId ?? null,
    // 规格是 file 形态的唯一入口；商品级写路径保持 text/url。
    allowFileForm: true,
  })
}

/**
 * P5：校验规格挂载的交付文件可用。归属别家 → 404（防枚举，与"文件不存在"
 * 不可区分）；revoked/deleted → 400（吊销即停售）。
 */
async function assertMyDeliveryFile(tx: Prisma.TransactionClient | typeof prisma, merchantId: number, fileId: number) {
  const file = await tx.deliveryFile.findFirst({
    where: { id: fileId, merchantId },
    select: { status: true },
  })
  if (!file) throw notFound('交付文件不存在')
  if (file.status !== 'active') throw badRequest('交付文件已不可用，请重新上传')
}

export async function listMyOffers(merchantId: number, productId: number) {
  await assertMyProduct(merchantId, productId)
  return prisma.offer.findMany({
    where: { productId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    // P5：管理 UI 需要展示已挂载文件的名称/大小/可用状态。
    include: { fixedFile: { select: { fileName: true, size: true, status: true } } },
  })
}

/**
 * 校验并写入一条规格（不同步投影，调用方负责在同事务里收尾）。
 * createMyOffer 与向导原子发布（createMyProduct 的 offers）共用。
 */
async function insertOffer(
  tx: Prisma.TransactionClient,
  merchantId: number,
  productId: number,
  input: OfferWriteInput & { name: string; price: number }
) {
  const deliveryMode = input.deliveryMode ?? 'instant_inventory'
  const stockMode = input.stockMode ?? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
  const fixedContentType = input.fixedContentType ?? 'text'
  const fixedFileId = input.fixedFileId ?? null
  assertOfferCommercialInput({
    price: input.price,
    originalPrice: input.originalPrice ?? null,
    deliveryMode,
    stockMode,
    incomingStock: input.stock,
    effectiveStock: input.stock,
    fixedContent: input.fixedContent,
    fixedContentType,
    fixedFileId,
  })
  assertDeliveryFieldsAllowed(deliveryMode, input.deliveryFields)
  await assertAutoProvisionAllowed(tx, merchantId, input.autoProvision ?? false, deliveryMode, input.deliveryFields)
  if (fixedFileId != null) {
    await assertMyDeliveryFile(tx, merchantId, fixedFileId)
  }

  // v1: platform FakaBridge credentials are global — only admins may attach SKUs.
  if (input.externalIntegration != null && input.externalIntegration !== '') {
    throw badRequest('FakaBridge 外部开通仅平台管理员可配置，商家请使用自动开通 webhook 或人工交付')
  }
  if (input.externalSku != null && input.externalSku !== '') {
    throw badRequest('FakaBridge externalSku 仅平台管理员可配置')
  }
  const faka = normalizeFakaOfferIntegration({
    externalIntegration: null,
    externalSku: null,
    deliveryMode,
  })
  assertOfferProvisionMutex({
    autoProvision: input.autoProvision ?? false,
    externalIntegration: faka.externalIntegration,
  })

  return tx.offer.create({
    data: {
      productId,
      name: input.name,
      price: input.price,
      originalPrice: input.originalPrice ?? null,
      status: input.status ?? 'active',
      deliveryMode,
      stockMode,
      stock: deliveryMode === 'instant_inventory' ? 0 : (input.stock ?? 0),
      fixedContent: input.fixedContent ?? null,
      fixedContentType,
      fixedFileId,
      sortOrder: input.sortOrder ?? 0,
      // P6a：订阅有效期；null = 永久。
      validityDays: input.validityDays ?? null,
      deliveryFields: input.deliveryFields ?? undefined,
      // P7b：自动开通开关（上方已过前置校验 + 与 Faka 互斥）。
      autoProvision: input.autoProvision ?? false,
      externalIntegration: faka.externalIntegration,
      externalSku: faka.externalSku,
    },
  })
}

export async function createMyOffer(
  merchantId: number,
  productId: number,
  input: OfferWriteInput & { name: string; price: number }
) {
  await assertMyProduct(merchantId, productId)
  const offer = await prisma.$transaction(async tx => {
    const created = await insertOffer(tx, merchantId, productId, input)
    await syncProductProjection(tx, productId)
    return created
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return offer
}

export async function updateMyOffer(
  merchantId: number,
  productId: number,
  offerId: number,
  input: OfferWriteInput
) {
  await assertMyProduct(merchantId, productId)

  const updated = await prisma.$transaction(async tx => {
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')

    const deliveryMode = input.deliveryMode ?? offer.deliveryMode
    if (deliveryMode !== offer.deliveryMode) {
      // 与商品级规则一致：已有库存记录或订单的规格不能改履约模式。
      const [inventoryCount, orderCount] = await Promise.all([
        tx.inventoryItem.count({ where: { offerId: offer.id } }),
        tx.order.count({ where: { offerId: offer.id } }),
      ])
      if (inventoryCount > 0 || orderCount > 0) {
        throw badRequest('该规格已有库存记录或订单，不能修改履约模式')
      }
    }
    const stockMode = input.stockMode
      ?? (deliveryMode !== offer.deliveryMode
        ? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
        : offer.stockMode)
    const fixedContentType = input.fixedContentType ?? offer.fixedContentType
    const nextFixedContent = 'fixedContent' in input ? (input.fixedContent ?? null) : offer.fixedContent
    // P5：合并后的文件挂载必须满足 file 形态不变量（含"切回 text/url 但留文件"）。
    const nextFixedFileId = 'fixedFileId' in input ? (input.fixedFileId ?? null) : offer.fixedFileId
    // P4b：合并后的模板不得出现在 instant_fixed 规格上（含"改模式但留模板"）。
    const nextDeliveryFields = 'deliveryFields' in input
      ? input.deliveryFields ?? null
      : parseStoredDeliveryFields(offer.deliveryFields)
    assertDeliveryFieldsAllowed(deliveryMode, nextDeliveryFields)
    // P7b：合并后的开关状态必须整体合法（含"改模式/加模板但留开关"的组合）。
    const nextAutoProvision = input.autoProvision ?? offer.autoProvision
    await assertAutoProvisionAllowed(tx, merchantId, nextAutoProvision, deliveryMode, nextDeliveryFields)
    assertOfferCommercialInput({
      price: input.price ?? offer.price,
      originalPrice: 'originalPrice' in input ? (input.originalPrice ?? null) : offer.originalPrice,
      deliveryMode,
      stockMode,
      // 仅当本次显式改库存时才作为"设置库存"判定（即时库存模式会拒绝）；
      // 有效容量取合并值供 limited 非负校验。
      incomingStock: input.stock,
      effectiveStock: input.stock ?? offer.stock,
      fixedContent: deliveryMode === 'instant_fixed' ? nextFixedContent : undefined,
      fixedContentType,
      fixedFileId: nextFixedFileId,
    })
    if (nextFixedFileId != null && nextFixedFileId !== offer.fixedFileId) {
      await assertMyDeliveryFile(tx, merchantId, nextFixedFileId)
    }

    // FakaBridge：请求触碰 integration/sku，或规格已启用 faka 时（履约模式变更也要重验）。
    const fakaFieldsTouched = 'externalIntegration' in input || 'externalSku' in input
    if (fakaFieldsTouched) {
      const ei = 'externalIntegration' in input ? input.externalIntegration : null
      const es = 'externalSku' in input ? input.externalSku : null
      if ((ei != null && ei !== '') || (es != null && es !== '')) {
        throw badRequest('FakaBridge 外部开通仅平台管理员可配置，商家请使用自动开通 webhook 或人工交付')
      }
    }
    const nextExternalIntegration = fakaFieldsTouched
      ? ('externalIntegration' in input ? input.externalIntegration : offer.externalIntegration)
      : offer.externalIntegration
    const nextExternalSku = fakaFieldsTouched
      ? ('externalSku' in input ? input.externalSku : offer.externalSku)
      : offer.externalSku
    const mustValidateFaka =
      fakaFieldsTouched || offer.externalIntegration != null || nextExternalIntegration != null
    const fakaUpdate = mustValidateFaka
      ? normalizeFakaOfferIntegration(
          {
            externalIntegration: nextExternalIntegration,
            externalSku: nextExternalSku,
            deliveryMode,
          },
          { requireConfigured: nextExternalIntegration === 'faka_bridge' }
        )
      : null

    const effectiveExternalIntegration =
      fakaUpdate != null ? fakaUpdate.externalIntegration : offer.externalIntegration
    assertOfferProvisionMutex({
      autoProvision: nextAutoProvision,
      externalIntegration: effectiveExternalIntegration,
    })

    // 设为默认：先清旧默认再随本次更新立新默认（同事务；部分唯一索引兜底并发）。
    // 取消默认只能通过在另一条上设默认完成，保证"每商品恰有一条默认"不变量。
    if (input.isDefault === true && !offer.isDefault) {
      await tx.offer.updateMany({ where: { productId, isDefault: true }, data: { isDefault: false } })
    } else if (input.isDefault === false && offer.isDefault) {
      throw badRequest('不能直接取消默认规格，请在其他规格上设为默认')
    }

    const next = await tx.offer.update({
      where: { id: offer.id },
      data: {
        ...(input.isDefault === true ? { isDefault: true } : {}),
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.price != null ? { price: input.price } : {}),
        ...('originalPrice' in input ? { originalPrice: input.originalPrice ?? null } : {}),
        ...(input.status != null ? { status: input.status } : {}),
        deliveryMode,
        stockMode,
        ...(input.stock != null ? { stock: input.stock } : {}),
        ...('fixedContent' in input ? { fixedContent: input.fixedContent ?? null } : {}),
        fixedContentType,
        ...('fixedFileId' in input ? { fixedFileId: input.fixedFileId ?? null } : {}),
        // P6a：改时长只影响新订单（快照冻结）；null = 改回永久。
        ...('validityDays' in input ? { validityDays: input.validityDays ?? null } : {}),
        // P7b：开关改动进 checkoutVersion，买家预览后改动会 409 重新确认。
        ...(input.autoProvision != null ? { autoProvision: input.autoProvision } : {}),
        ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
        // 改模板仅影响后续导入/交付；已导入条目携带自包含快照，不回填。
        ...('deliveryFields' in input
          ? { deliveryFields: input.deliveryFields === null ? Prisma.DbNull : input.deliveryFields }
          : {}),
        ...(deliveryMode === 'instant_inventory' && offer.deliveryMode !== 'instant_inventory'
          ? { stock: 0 }
          : {}),
        ...(fakaUpdate
          ? {
              externalIntegration: fakaUpdate.externalIntegration,
              externalSku: fakaUpdate.externalSku,
            }
          : {}),
      },
    })
    await syncProductProjection(tx, productId)
    return next
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return updated
}

export async function deleteMyOffer(merchantId: number, productId: number, offerId: number) {
  await assertMyProduct(merchantId, productId)

  await prisma.$transaction(async tx => {
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')

    const total = await tx.offer.count({ where: { productId } })
    if (total <= 1) throw badRequest('商品至少保留一个规格，可改为下架该规格')

    // 有库存记录或订单的规格只能下架（inactive），不能删除——审计与快照回溯依赖它。
    const [inventoryCount, orderCount] = await Promise.all([
      tx.inventoryItem.count({ where: { offerId: offer.id } }),
      tx.order.count({ where: { offerId: offer.id } }),
    ])
    if (inventoryCount > 0 || orderCount > 0) {
      throw badRequest('该规格已有库存记录或订单，只能下架不能删除')
    }

    await tx.offer.delete({ where: { id: offer.id } })
    // 删除的是默认规格 → 自动把剩余规格里 sortOrder 最靠前的提为默认，
    // 保持"每商品恰有一条默认"的兼容路径不变量（无需商家额外操作）。
    if (offer.isDefault) {
      const next = await tx.offer.findFirst({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      })
      if (next) await tx.offer.update({ where: { id: next.id }, data: { isDefault: true } })
    }
    await syncProductProjection(tx, productId)
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return { deleted: true }
}
