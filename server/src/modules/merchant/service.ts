import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, conflict } from '../../lib/httpError.js'

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

export async function listMyProducts(merchantId: number, page = 1, pageSize = 20) {
  return prisma.product.findMany({
    where: { merchantId },
    include: { _count: { select: { inventory: { where: { status: 'available' } } } } },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
}

export async function createMyProduct(
  merchantId: number,
  data: {
    name: string; description?: string; richDescription?: string;
    type: string; icon?: string; imageUrl?: string;
    price: number; originalPrice?: number; isHot?: boolean
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

export async function importMyInventory(merchantId: number, productId: number, items: string[]) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId } })
  if (!product) throw notFound('商品不存在')

  return prisma.$transaction(async tx => {
    for (const content of items) {
      await tx.inventoryItem.create({ data: { productId, content } })
    }
    await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: items.length } },
    })
    return { imported: items.length }
  })
}

// ---- Orders ----

export async function listMyOrders(merchantId: number, page = 1, pageSize = 20) {
  return prisma.order.findMany({
    where: { merchantId },
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { name: true } },
      delivery: { select: { content: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
}

export async function getMyOrderDetail(merchantId: number, orderId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { id: true, name: true, icon: true, type: true, price: true } },
      delivery: { select: { content: true, status: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return order
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
