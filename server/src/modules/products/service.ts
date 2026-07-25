import { Buffer } from 'node:buffer'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { wrapCache } from '../../lib/cache.js'
import { badRequest, HttpError, notFound } from '../../lib/httpError.js'
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
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true } },
} satisfies Prisma.ProductSelect

type ProductListItem = Prisma.ProductGetPayload<{ select: typeof productListSelect }>
type ProductDetail = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>

function serializePublicProductListItem(product: ProductListItem) {
  const { _count, ...publicProduct } = product
  return {
    ...publicProduct,
    // 即时库存以实际可用条目计数为准，不能读取可能过期的 Product.stock 投影。
    stock: product.deliveryMode === 'instant_inventory' ? _count.inventory : product.stock,
    ratingAvg: Number(product.ratingAvg),
  }
}

function serializePublicProductDetail(product: ProductDetail) {
  const { _count, ...publicProduct } = product
  return {
    ...publicProduct,
    stock: product.deliveryMode === 'instant_inventory' ? _count.inventory : product.stock,
    ratingAvg: Number(product.ratingAvg),
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

  return {
    items: items.map(serializePublicProductListItem),
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
  return serializePublicProductDetail(product)
}
