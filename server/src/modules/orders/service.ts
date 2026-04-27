import { prisma } from '../auth/service.js'

/**
 * 兑换订单 - 核心事务
 * 
 * 注意：当前使用 SQLite（开发环境），不支持 FOR UPDATE 行级锁。
 * 上线切换到 PostgreSQL 后，应将 findUnique 替换为 $queryRaw + FOR UPDATE。
 * SQLite 的事务隔离级别为 Serializable，天然串行化。
 */
export async function createOrder(userId: number, productId: number) {
  return prisma.$transaction(async (tx) => {
    // 1. 获取积分账户
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw new Error('积分账户不存在')

    // 2. 检查商品状态
    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw new Error('商品不存在')
    if (product.status !== 'active') throw new Error('商品已下架')

    // 3. 检查余额
    if (account.balance < product.price) throw new Error('积分不足')

    // 4. 查找可用库存
    const item = await tx.inventoryItem.findFirst({
      where: { productId, status: 'available' },
      orderBy: { id: 'asc' },
    })
    if (!item) throw new Error('库存不足，请稍后再试')

    const newBalance = account.balance - product.price

    // 5. 扣积分
    await tx.pointAccount.update({
      where: { userId },
      data: { balance: newBalance },
    })

    // 6. 创建订单
    const order = await tx.order.create({
      data: { userId, productId, price: product.price, status: 'completed' },
    })

    // 7. 标记库存已售
    await tx.inventoryItem.update({
      where: { id: item.id },
      data: {
        status: 'sold',
        orderId: order.id,
        soldToUserId: userId,
        soldAt: new Date(),
      },
    })

    // 8. 创建发货记录
    await tx.deliveryRecord.create({
      data: {
        orderId: order.id,
        userId,
        productId,
        content: item.content,
        status: 'delivered',
      },
    })

    // 9. 写积分流水
    await tx.pointLog.create({
      data: {
        userId,
        type: 'out',
        amount: product.price,
        balanceAfter: newBalance,
        reason: `兑换商品: ${product.name}`,
      },
    })

    // 10. 更新商品缓存字段
    await tx.product.update({
      where: { id: productId },
      data: { stock: { decrement: 1 }, sales: { increment: 1 } },
    })

    return {
      orderId: order.id,
      productName: product.name,
      price: product.price,
      deliveryContent: item.content,
      balanceAfter: newBalance,
    }
  })
}

export async function getUserOrders(userId: number) {
  return prisma.order.findMany({
    where: { userId },
    include: {
      product: { select: { name: true, icon: true, type: true } },
      delivery: { select: { content: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
}
