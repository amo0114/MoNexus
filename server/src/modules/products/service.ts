import { Buffer } from 'node:buffer'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'

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
  merchant: { select: { id: true, name: true } },
} satisfies Prisma.ProductSelect

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
  const { query, category, cursor, page = 1, pageSize = 20 } = params
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
    items,
    nextCursor: hasMore && lastItem ? encodeProductCursor(lastItem) : null,
    hasMore,
  }
}

export async function getProductDetail(id: number) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      merchant: { select: { id: true, name: true } },
      reviews: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active') throw badRequest('商品已下架')
  // 安全红线：fixedContent 是付费内容，绝不能出现在公开详情中
  const { fixedContent: _fixedContent, ...publicProduct } = product
  return publicProduct
}
