import { Buffer } from 'node:buffer'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { wrapCache } from '../../lib/cache.js'
import { badRequest, HttpError, notFound } from '../../lib/httpError.js'
import { serializePublicOffer } from '../../lib/offers.js'
import {
  buildProductDetailCacheKey,
  buildProductListCacheKey,
} from './cache.js'

interface ProductListParams {
  query?: string
  category?: string
  cursor?: string
  page?: number
  pageSize?: number
}

interface ProductCursor {
  isHot: boolean
  sales: number
  id: number
}

const productListSelect = {
  id: true,
  name: true,
  description: true,
  type: true,
  icon: true,
  imageUrl: true,
  images: true,
  price: true,
  originalPrice: true,
  stock: true,
  sales: true,
  isHot: true,
  status: true,
  deliveryMode: true,
  stockMode: true,
  ratingAvg: true,
  ratingCount: true,
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true } },
  // P4a：公开可售状态从 active 规格集合推导，不再信任 Product 投影——
  // stockMode 投影取自默认规格（可能已下架），混合规格商品会误报售罄/不限。
  offers: {
    where: { status: 'active' },
    select: { id: true, deliveryMode: true, stockMode: true, stock: true },
  },
} satisfies Prisma.ProductSelect

const productDetailSelect = {
  id: true,
  name: true,
  description: true,
  richDescription: true,
  type: true,
  icon: true,
  imageUrl: true,
  images: true,
  price: true,
  originalPrice: true,
  stock: true,
  sales: true,
  isHot: true,
  status: true,
  deliveryMode: true,
  stockMode: true,
  // 购买前表单定义：买家需在详情/结算时看到并填写，属公开数据（答案才是敏感的）。
  purchaseForm: true,
  ratingAvg: true,
  ratingCount: true,
  // P4a：公开 SKU 列表（仅 active）；序列化经 serializePublicOffer 剥离 fixedContent。
  offers: { where: { status: 'active' }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true } },
} satisfies Prisma.ProductSelect

type ProductListItem = Prisma.ProductGetPayload<{ select: typeof productListSelect }>
type ProductDetail = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>

type AvailabilityOffer = { id: number; deliveryMode: string; stockMode: string; stock: number }

/**
 * 公开可售状态（stock/stockMode 契约字段）从 active 规格集合推导：
 * - 任一 active 规格不限量 → 商品不限量（列表/详情永不显示售罄）
 * - 否则 stock = 各 active 规格可售量之和（即时库存规格用真实可用条目数，
 *   Offer.stock 在该模式下是无人维护的陈旧值）
 * 前端的售罄判断（stockMode !== 'unlimited' && stock === 0）契约不变。
 * offers 为空（迁移前数据兜底）时退回投影语义。
 */
function computePublicAvailability(
  product: { deliveryMode: string; stockMode: string; stock: number; _count: { inventory: number } },
  offers: AvailabilityOffer[],
  offerAvailableCounts: Map<number, number>
): { stock: number; stockMode: string } {
  if (offers.length === 0) {
    return {
      stock: product.deliveryMode === 'instant_inventory' ? product._count.inventory : product.stock,
      stockMode: product.stockMode,
    }
  }
  if (offers.some(offer => offer.stockMode === 'unlimited')) {
    return { stock: product.stock, stockMode: 'unlimited' }
  }
  const stock = offers.reduce(
    (sum, offer) =>
      sum +
      (offer.deliveryMode === 'instant_inventory'
        ? offerAvailableCounts.get(offer.id) ?? 0
        : offer.stock),
    0
  )
  return { stock, stockMode: 'limited' }
}

/** 批量取即时库存规格的真实可用条目数（一次 groupBy 服务整页/单品）。 */
async function countAvailableByOffer(offers: AvailabilityOffer[]): Promise<Map<number, number>> {
  const instantOfferIds = offers
    .filter(offer => offer.deliveryMode === 'instant_inventory')
    .map(offer => offer.id)
  const counts = new Map<number, number>()
  if (instantOfferIds.length === 0) return counts
  const grouped = await prisma.inventoryItem.groupBy({
    by: ['offerId'],
    where: { offerId: { in: instantOfferIds }, status: 'available' },
    _count: { _all: true },
  })
  for (const row of grouped) counts.set(row.offerId, row._count._all)
  return counts
}

function serializePublicProductListItem(
  product: ProductListItem,
  offerAvailableCounts: Map<number, number>
) {
  const { _count, offers, ...publicProduct } = product
  return {
    ...publicProduct,
    // 可售状态由 active 规格推导；列表载荷保持精简，不携带 offers 数组。
    ...computePublicAvailability(product, offers, offerAvailableCounts),
    ratingAvg: Number(product.ratingAvg),
  }
}

function serializePublicProductDetail(
  product: ProductDetail,
  offerAvailableCounts: Map<number, number>
) {
  const { _count, offers, ...publicProduct } = product
  return {
    ...publicProduct,
    // 顶层 stock/stockMode 与列表同一推导（单规格详情页直接用它判断售罄）。
    ...computePublicAvailability(product, offers, offerAvailableCounts),
    ratingAvg: Number(product.ratingAvg),
    // 公开 Offer 剥离 fixedContent；即时库存规格的 stock 用实际可用条目数。
    offers: offers.map(offer => {
      const serialized = serializePublicOffer(offer)
      return offer.deliveryMode === 'instant_inventory'
        ? { ...serialized, stock: offerAvailableCounts.get(offer.id) ?? 0 }
        : serialized
    }),
  }
}

function encodeProductCursor(product: ProductCursor) {
  return Buffer
    .from(JSON.stringify({ isHot: product.isHot, sales: product.sales, id: product.id }), 'utf8')
    .toString('base64url')
}

function decodeProductCursor(cursor: string): ProductCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!value || typeof value !== 'object') {
      throw new Error('invalid cursor')
    }

    const { isHot, sales, id } = value as Record<string, unknown>
    if (
      typeof isHot !== 'boolean' ||
      typeof sales !== 'number' ||
      typeof id !== 'number' ||
      !Number.isInteger(sales) ||
      !Number.isInteger(id) ||
      sales < 0 ||
      id <= 0
    ) {
      throw new Error('invalid cursor')
    }
    return { isHot, sales, id }
  } catch {
    throw badRequest('分页游标无效')
  }
}

function buildCursorWhere(cursor: ProductCursor): Prisma.ProductWhereInput {
  if (cursor.isHot) {
    return {
      OR: [
        { isHot: false },
        { isHot: true, sales: { lt: cursor.sales } },
        { isHot: true, sales: cursor.sales, id: { lt: cursor.id } },
      ],
    }
  }

  return {
    isHot: false,
    OR: [
      { sales: { lt: cursor.sales } },
      { sales: cursor.sales, id: { lt: cursor.id } },
    ],
  }
}

export async function listProducts(params: ProductListParams = {}) {
  const cacheKey = await buildProductListCacheKey(params)
  if (!cacheKey) return listProductsFromDb(params)

  const ttlSec = params.query ? 10 : params.cursor ? 20 : 30
  return wrapCache('product-list', cacheKey, ttlSec, () => listProductsFromDb(params))
}

async function listProductsFromDb(params: ProductListParams = {}) {
  const query = params.query?.trim()
  const category = params.category?.trim()
  const { cursor, page = 1, pageSize = 20 } = params
  const baseWhere: Prisma.ProductWhereInput = { status: 'active' }

  if (category && category !== '全部') {
    baseWhere.type = category
  }

  if (query) {
    baseWhere.OR = [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { type: { contains: query, mode: 'insensitive' } },
    ]
  }

  const cursorValue = cursor ? decodeProductCursor(cursor) : null
  const where: Prisma.ProductWhereInput = cursorValue
    ? { AND: [baseWhere, buildCursorWhere(cursorValue)] }
    : baseWhere

  const products = await prisma.product.findMany({
    where,
    orderBy: [{ isHot: 'desc' }, { sales: 'desc' }, { id: 'desc' }],
    select: productListSelect,
    skip: cursorValue ? undefined : (page - 1) * pageSize,
    take: pageSize + 1,
  })

  const items = products.slice(0, pageSize)
  const hasMore = products.length > pageSize
  const lastItem = items.at(-1)

  const offerAvailableCounts = await countAvailableByOffer(items.flatMap(item => item.offers))

  return {
    items: items.map(item => serializePublicProductListItem(item, offerAvailableCounts)),
    nextCursor: hasMore && lastItem ? encodeProductCursor(lastItem) : null,
    hasMore,
  }
}

export async function getProductDetail(id: number) {
  const cacheKey = await buildProductDetailCacheKey(id)
  if (!cacheKey) return getProductDetailFromDb(id)

  return wrapCache('product-detail', cacheKey, 60, () => getProductDetailFromDb(id), {
    negativeTtlSec: 20,
    negativeErrorPredicate: err => err instanceof HttpError && err.status === 404,
  })
}

async function getProductDetailFromDb(id: number) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: productDetailSelect,
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active') throw badRequest('商品已下架')

  const offerAvailableCounts = await countAvailableByOffer(product.offers)
  return serializePublicProductDetail(product, offerAvailableCounts)
}
