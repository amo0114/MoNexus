import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { badRequest, notFound, conflict } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { serializeMerchantOrder } from '../orders/serializers.js'

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

export interface InventoryImportPayload {
  text?: string
  items?: string[]
}

type InventoryAnalysis = {
  totalRows: number
  validRows: number
  emptyRows: number
  duplicateRows: number
  existingDuplicateRows: number
  canImport: boolean
  itemsToImport: string[]
}

type InventoryClient = typeof prisma | Prisma.TransactionClient

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
  const availableStock = product._count.inventory
  return product.deliveryMode === 'instant_inventory' && availableStock <= threshold
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
    price: product.price,
    originalPrice: product.originalPrice,
    stock: product.stock,
    availableStock,
    sales: product.sales,
    isHot: product.isHot,
    status: product.status,
    deliveryMode: product.deliveryMode,
    merchantId: product.merchantId,
    createdAt: product.createdAt,
    lowStock: isLowStockProduct(product, lowStockThreshold),
  }
}

function inventoryRowsFromPayload(payload: InventoryImportPayload) {
  const rows: string[] = []
  if (typeof payload.text === 'string') rows.push(...payload.text.split(/\r?\n/))
  if (Array.isArray(payload.items)) rows.push(...payload.items)
  return rows
}

async function analyzeInventoryPayload(
  productId: number,
  payload: InventoryImportPayload,
  client: InventoryClient = prisma
): Promise<InventoryAnalysis> {
  const rows = inventoryRowsFromPayload(payload)
  const seen = new Set<string>()
  const uniqueRows: string[] = []
  let emptyRows = 0
  let duplicateRows = 0

  for (const row of rows) {
    const normalized = row.trim()
    if (!normalized) {
      emptyRows += 1
      continue
    }
    if (seen.has(normalized)) {
      duplicateRows += 1
      continue
    }
    seen.add(normalized)
    uniqueRows.push(normalized)
  }

  const existingRows = uniqueRows.length > 0
    ? await client.inventoryItem.findMany({
        where: { productId, content: { in: uniqueRows } },
        select: { content: true },
      })
    : []
  const existingContents = new Set(existingRows.map(row => row.content))
  const itemsToImport = uniqueRows.filter(row => !existingContents.has(row))

  return {
    totalRows: rows.length,
    validRows: itemsToImport.length,
    emptyRows,
    duplicateRows,
    existingDuplicateRows: existingContents.size,
    canImport: itemsToImport.length > 0 && duplicateRows === 0 && existingContents.size === 0,
    itemsToImport,
  }
}

function duplicateImportDetails(analysis: InventoryAnalysis) {
  return [
    { field: 'items', message: `duplicateRows=${analysis.duplicateRows}` },
    { field: 'items', message: `existingDuplicateRows=${analysis.existingDuplicateRows}` },
  ]
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
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  const analysis = await analyzeInventoryPayload(productId, payload)
  return {
    totalRows: analysis.totalRows,
    validRows: analysis.validRows,
    emptyRows: analysis.emptyRows,
    duplicateRows: analysis.duplicateRows,
    existingDuplicateRows: analysis.existingDuplicateRows,
    canImport: analysis.canImport,
  }
}

export async function createMyProduct(
  merchantId: number,
  data: {
    name: string; description?: string; richDescription?: string;
    type: string; icon?: string; imageUrl?: string;
    price: number; originalPrice?: number; isHot?: boolean; deliveryMode?: string
  }
) {
  return prisma.product.create({
    data: { ...data, merchantId },
  })
}

export async function updateMyProduct(merchantId: number, productId: number, data: Record<string, unknown>) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId } })
  if (!product) throw notFound('商品不存在')
  return prisma.product.update({ where: { id: productId }, data })
}

export async function importMyInventory(
  merchantId: number,
  productId: number,
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')

  return prisma.$transaction(async tx => {
    const analysis = await analyzeInventoryPayload(productId, payload, tx)
    if (analysis.duplicateRows > 0 || analysis.existingDuplicateRows > 0) {
      throw badRequest('库存导入包含重复项', duplicateImportDetails(analysis))
    }
    if (analysis.validRows === 0) {
      throw badRequest('至少提供一条有效库存')
    }

    for (const content of analysis.itemsToImport) {
      await tx.inventoryItem.create({ data: { productId, content } })
    }
    await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: analysis.itemsToImport.length } },
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
}

// ---- Orders ----

export async function listMyOrders(merchantId: number, page = 1, pageSize = 20) {
  const orders = await prisma.order.findMany({
    where: { merchantId },
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { name: true } },
      delivery: { select: { status: true } },
      settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
  return orders.map(serializeMerchantOrder)
}

export async function getMyOrderDetail(merchantId: number, orderId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { id: true, name: true, icon: true, type: true, price: true } },
      delivery: { select: { status: true } },
      settlement: { select: { settlementAmount: true, status: true, settledAt: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return serializeMerchantOrder(order)
}

// ---- Settlements ----

export async function listMySettlements(merchantId: number, page = 1, pageSize = 20) {
  return prisma.settlement.findMany({
    where: { merchantId },
    include: {
      order: {
        select: { id: true, price: true, createdAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
}

// ---- Stats ----

export async function getMyStats(merchantId: number) {
  const [productCount, orderCount, revenueResult, pendingSettlement] = await Promise.all([
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
  ])

  return {
    productCount,
    orderCount,
    totalRevenue: revenueResult._sum.settlementAmount ?? 0,
    pendingSettlement: pendingSettlement._sum.settlementAmount ?? 0,
  }
}
