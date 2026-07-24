import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { badRequest, notFound, conflict } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import {
  assertProductDeliveryConfiguration,
  normalizeProductImageFields,
} from '../../lib/productCommercial.js'
import {
  analyzeInventoryImport,
  duplicateInventoryImportDetails,
  isInventoryContentUniqueViolation,
  type InventoryImportPayload,
} from '../../lib/inventoryImport.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import {
  isInstantMode,
  normalizeOrderStatus,
  transitionOrderStatus,
  type FulfillmentOrderStatus,
} from '../orders/fulfillment.js'
import { releaseHeldOrder, settleHeldOrder } from '../orders/accounting.js'
import { serializeMerchantOrder } from '../orders/serializers.js'
import type { MerchantOrderListQuery } from './schema.js'

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
} as const

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
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true, deliveryMode: true } })
  if (!product) throw notFound('商品不存在')
  if (product.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
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
    stockMode?: string; stock?: number; fixedContent?: string; fixedContentType?: string
  }
) {
  assertOriginalPriceAtLeastSale(data.price, data.originalPrice)
  const normalizedProductData = normalizeProductImageFields(data)
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

  const product = await prisma.product.create({
    data: {
      ...normalizedProductData,
      deliveryMode,
      stockMode,
      fixedContentType,
      stock: deliveryMode === 'instant_inventory' ? 0 : (data.stock ?? 0),
      merchantId,
    },
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

  assertProductDeliveryConfiguration({
    deliveryMode,
    stockMode,
    incomingStock,
    effectiveStock: incomingStock ?? product.stock,
    fixedContent: 'fixedContent' in normalizedProductData
      ? (normalizedProductData.fixedContent as string | null)
      : product.fixedContent,
    fixedContentType: (normalizedProductData.fixedContentType as string | undefined) ?? product.fixedContentType,
  })

  const updated = await prisma.product.update({
    where: { id: productId },
    data: {
      ...normalizedProductData,
      deliveryMode,
      stockMode,
      // 新建/无业务记录商品切到即时库存时，遗留的额度字段不再代表库存。
      ...(deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
        ? { stock: 0 }
        : {}),
    },
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
  input: { delta: number; reason: string }
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, merchantId },
    select: { id: true, deliveryMode: true, stockMode: true },
  })
  if (!product) throw notFound('商品不存在')
  if (product.deliveryMode === 'instant_inventory') {
    throw badRequest('即时库存商品请通过交付库存导入或作废管理')
  }
  if (product.stockMode !== 'limited') {
    throw badRequest('不限量商品无需调整可售名额')
  }

  const result = await prisma.$transaction(async tx => {
    if (input.delta > 0) {
      const updated = await tx.product.updateMany({
        where: {
          id: productId,
          merchantId,
          stockMode: 'limited',
          deliveryMode: { not: 'instant_inventory' },
        },
        data: { stock: { increment: input.delta } },
      })
      if (updated.count !== 1) throw badRequest('商品库存模式已变更，请刷新后重试')
    } else {
      const updated = await tx.product.updateMany({
        where: {
          id: productId,
          merchantId,
          stockMode: 'limited',
          deliveryMode: { not: 'instant_inventory' },
          stock: { gte: -input.delta },
        },
        data: { stock: { decrement: -input.delta } },
      })
      if (updated.count !== 1) throw badRequest('减少数量不能超过当前可售名额')
    }

    const updatedProduct = await tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { stock: true },
    })
    await logInventoryChange(tx, {
      productId,
      merchantId,
      actorUserId,
      action: 'capacity_adjust',
      delta: input.delta,
      reason: input.reason,
    })
    return { stock: updatedProduct.stock }
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}

export async function importMyInventory(
  merchantId: number,
  actorUserId: number,
  productId: number,
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true, deliveryMode: true } })
  if (!product) throw notFound('商品不存在')
  if (product.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }

  try {
    const result = await prisma.$transaction(async tx => {
      const analysis = await analyzeInventoryImport(productId, payload, tx)
      if (analysis.duplicateRows > 0 || analysis.existingDuplicateRows > 0) {
        throw badRequest('库存导入包含重复项', duplicateInventoryImportDetails(analysis))
      }
      if (analysis.validRows === 0) {
        throw badRequest('至少提供一条有效库存')
      }

      await tx.inventoryItem.createMany({
        data: analysis.itemsToImport.map(content => ({ productId, content })),
      })
      await logInventoryChange(tx, {
        productId,
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
  input: { count: number; reason?: string }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true, deliveryMode: true } })
  if (!product) throw notFound('商品不存在')
  if (product.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }

  // 单事务完成：InventoryItem 置 void + InventoryLog 落账。
  // 只允许作废 available 项；updateMany 二次过滤 status 防与下单占用并发竞态。
  const result = await prisma.$transaction(async tx => {
    const candidates = await tx.inventoryItem.findMany({
      where: { productId, status: 'available' },
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
  if (status === 'processing' && deliveryMode === 'manual_service') return ['deliver']
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
      },
      orderBy: { createdAt: 'desc' },
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
      delivery: { select: { status: true, publicNote: true, deliveredAt: true } },
      settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
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
    slaExceeded: computeSlaExceeded(order),
    availableActions: getAvailableActions(order),
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
  input: { deliveryContent?: string; publicNote?: string; internalNote?: string }
) {
  await prisma.$transaction(async tx => {
    const order = await assertMerchantOrder(merchantId, orderId, tx)
    if (getOrderDeliveryMode(order) !== 'manual_service') {
      throw badRequest('只有人工服务订单可由商家履约交付')
    }

    await transitionOrderStatus({
      orderId,
      toStatus: 'delivered',
      actorRole: 'merchant',
      actorUserId,
      action: 'merchant.fulfillment.deliver',
      deliveryContent: input.deliveryContent,
      publicNote: input.publicNote,
      internalNote: input.internalNote,
    }, tx)

  })

  return getMyOrderDetail(merchantId, orderId)
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
