import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'

export async function listProducts(query?: string, category?: string, page = 1, pageSize = 20) {
  const where: Prisma.ProductWhereInput = { status: 'active' }

  if (category && category !== '全部') {
    where.type = category
  }

  if (query) {
    where.OR = [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { type: { contains: query, mode: 'insensitive' } },
    ]
  }

  return prisma.product.findMany({
    where,
    orderBy: [{ isHot: 'desc' }, { sales: 'desc' }],
    select: {
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
      merchant: { select: { id: true, name: true } },
    },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
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
  return product
}
