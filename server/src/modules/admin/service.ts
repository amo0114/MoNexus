import { prisma } from '../auth/service.js'

export async function getStats() {
  const [userCount, orderCount, totalPoints] = await Promise.all([
    prisma.user.count(),
    prisma.order.count(),
    prisma.pointAccount.aggregate({ _sum: { balance: true } }),
  ])

  return {
    users: userCount,
    orders: orderCount,
    totalPoints: totalPoints._sum.balance ?? 0,
  }
}

export async function listUsers(query?: string) {
  const where: any = {}
  if (query) {
    where.email = { contains: query }
  }

  return prisma.user.findMany({
    where,
    include: { pointAccount: { select: { balance: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function adjustUserPoints(
  adminUserId: number,
  targetUserId: number,
  type: 'add' | 'deduct',
  amount: number,
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const account = await tx.pointAccount.findUnique({ where: { userId: targetUserId } })
    if (!account) throw new Error('目标用户积分账户不存在')

    if (type === 'deduct' && account.balance < amount) {
      throw new Error('扣除数量不能大于用户当前余额')
    }

    const newBalance = type === 'add' ? account.balance + amount : account.balance - amount

    await tx.pointAccount.update({
      where: { userId: targetUserId },
      data: { balance: newBalance },
    })

    await tx.pointLog.create({
      data: {
        userId: targetUserId,
        type: type === 'add' ? 'in' : 'out',
        amount,
        balanceAfter: newBalance,
        reason: `后台调整: ${reason}`,
      },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: `${type === 'add' ? '增加' : '扣除'}积分`,
        targetType: 'user',
        targetId: targetUserId,
        detail: `${type === 'add' ? '+' : '-'}${amount}, 原因: ${reason}`,
      },
    })

    return { newBalance }
  })
}

export async function createProduct(data: any) {
  return prisma.product.create({ data })
}

export async function updateProduct(id: number, data: any) {
  return prisma.product.update({ where: { id }, data })
}

export async function importInventory(productId: number, items: string[], adminUserId: number) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw new Error('商品不存在')

  return prisma.$transaction(async (tx) => {
    for (const content of items) {
      await tx.inventoryItem.create({ data: { productId, content } })
    }

    await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: items.length } },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '导入库存',
        targetType: 'product',
        targetId: productId,
        detail: `导入 ${items.length} 条库存`,
      },
    })

    return { imported: items.length }
  })
}

export async function listAllOrders() {
  return prisma.order.findMany({
    include: {
      user: { select: { id: true, email: true } },
      product: { select: { name: true } },
      delivery: { select: { content: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
}

export async function listLogs() {
  return prisma.pointLog.findMany({
    include: {
      user: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
}

export async function listAdminProducts() {
  return prisma.product.findMany({
    include: {
      _count: {
        select: { inventory: { where: { status: 'available' } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}
