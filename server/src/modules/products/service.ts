import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'

export async function listProducts(query?: string, category?: string) {
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
      price: true,
      originalPrice: true,
      stock: true,
      sales: true,
      isHot: true,
      status: true,
    },
  })
}

export async function getProductDetail(id: number) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      reviews: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active') throw badRequest('商品已下架')
  return product
}
