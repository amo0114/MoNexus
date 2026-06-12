import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import {
  getSystemConfigValue,
  listSystemConfigs,
  updateSystemConfig as saveSystemConfig,
} from '../../lib/systemConfig.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { invalidate as invalidateUserStatusCache } from '../../lib/userStatusCache.js'
import { revokeAllUserRefreshTokens } from '../auth/service.js'
import { serializeAdminOrderDetail, serializeAdminOrderList } from '../orders/serializers.js'
import { getSettlementEligibility } from '../merchant/service.js'
import type { ListAdminAuditQuery, ListOrdersQuery, ListUsersQuery } from './schema.js'

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

function getShanghaiDayRange() {
  const now = new Date()
  const shanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  const start = new Date(shanghai.getFullYear(), shanghai.getMonth(), shanghai.getDate())
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { gte: start, lt: end }
}

export async function getStats() {
  const todayRange = getShanghaiDayRange()

  const [userCount, orderCount, totalPoints, todayOrders, todayCheckins, productCount, availableInventory] =
    await Promise.all([
      prisma.user.count(),
      prisma.order.count(),
      prisma.pointAccount.aggregate({ _sum: { balance: true } }),
      prisma.order.count({ where: { createdAt: todayRange } }),
      prisma.checkinRecord.count({ where: { createdAt: todayRange } }),
      prisma.product.count({ where: { status: 'active' } }),
      prisma.inventoryItem.count({ where: { status: 'available' } }),
    ])

  return {
    users: userCount,
    orders: orderCount,
    totalPoints: totalPoints._sum.balance ?? 0,
    todayOrders,
    todayCheckins,
    productCount,
    availableInventory,
  }
}

export async function listUsers(query: ListUsersQuery = {}) {
  const { page, pageSize } = await resolvePagination(query.page, query.pageSize)
  const where: Prisma.UserWhereInput = {}
  if (query.q) {
    where.OR = [
      { email: { contains: query.q, mode: 'insensitive' } },
      { merchant: { name: { contains: query.q, mode: 'insensitive' } } },
    ]
  }

  const [total, items] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        inviteCode: true,
        createdAt: true,
        pointAccount: { select: { balance: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return { items, total, page, pageSize }
}

export async function adjustUserPoints(
  adminUserId: number,
  targetUserId: number,
  type: 'add' | 'deduct',
  amount: number,
  reason: string
) {
  return prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId: targetUserId } })
    if (!account) throw notFound('目标用户积分账户不存在')

    if (type === 'deduct' && account.balance < amount) {
      throw badRequest('扣除数量不能大于用户当前余额')
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

export async function banUser(adminUserId: number, targetUserId: number, reason: string) {
  const updated = await prisma.$transaction(async tx => {
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) throw notFound('用户不存在')
    if (target.id === adminUserId) throw badRequest('不能封禁自己的账号')
    if (target.role === 'admin') throw badRequest('不能封禁管理员账号')

    const updated = await tx.user.update({
      where: { id: target.id },
      data: { status: '已封禁' },
      select: { id: true, email: true, role: true, status: true },
    })

    await revokeAllUserRefreshTokens(target.id, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '封禁用户',
        targetType: 'user',
        targetId: target.id,
        detail: `用户 ${target.email} 已封禁，原因: ${reason}`,
      },
    })

    return updated
  })

  invalidateUserStatusCache(targetUserId)
  return updated
}

export async function unbanUser(adminUserId: number, targetUserId: number) {
  const updated = await prisma.$transaction(async tx => {
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) throw notFound('用户不存在')

    const updated = await tx.user.update({
      where: { id: target.id },
      data: { status: '正常' },
      select: { id: true, email: true, role: true, status: true },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '解封用户',
        targetType: 'user',
        targetId: target.id,
        detail: `用户 ${target.email} 已解封`,
      },
    })

    return updated
  })

  invalidateUserStatusCache(targetUserId)
  return updated
}

export async function listSystemConfig() {
  return listSystemConfigs()
}

export async function updateSystemConfig(adminUserId: number, key: string, value: number) {
  return saveSystemConfig(adminUserId, key, value)
}

export async function createProduct(data: Prisma.ProductCreateInput) {
  return prisma.product.create({ data })
}

export async function updateProduct(id: number, data: Prisma.ProductUpdateInput) {
  const product = await prisma.product.findUnique({ where: { id } })
  if (!product) throw notFound('商品不存在')

  return prisma.product.update({ where: { id }, data })
}

export async function importInventory(productId: number, items: string[], adminUserId: number) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')
  if (product.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }

  return prisma.$transaction(async tx => {
    for (const content of items) {
      await tx.inventoryItem.create({ data: { productId, content } })
    }

    await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: items.length } },
    })

    await logInventoryChange(tx, {
      productId,
      merchantId: product.merchantId,
      actorUserId: adminUserId,
      action: 'import',
      delta: items.length,
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

function buildAdminOrderWhere(query: ListOrdersQuery): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {}

  if (query.status) {
    // 历史数据存在 legacy 'completed'，与 delivered 等价
    where.status = query.status === 'delivered' ? { in: ['delivered', 'completed'] } : query.status
  }

  if (query.q) {
    const conditions: Prisma.OrderWhereInput[] = [
      { user: { email: { contains: query.q, mode: 'insensitive' } } },
    ]
    const numeric = Number(query.q)
    if (/^\d+$/.test(query.q) && Number.isSafeInteger(numeric) && numeric > 0) {
      conditions.push({ id: numeric })
    }
    where.OR = conditions
  }

  return where
}

export async function listAllOrders(query: ListOrdersQuery = {}) {
  const { page, pageSize } = await resolvePagination(query.page, query.pageSize)
  const where = buildAdminOrderWhere(query)

  const [total, orders] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, email: true } },
        merchant: { select: { id: true, name: true } },
        product: { select: { name: true } },
        delivery: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return { items: orders.map(serializeAdminOrderList), total, page, pageSize }
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

function toDateEndOfDay(date: string) {
  const end = new Date(date)
  end.setUTCHours(23, 59, 59, 999)
  return end
}

export async function listAdminLogs(query: ListAdminAuditQuery) {
  const where: Prisma.AdminLogWhereInput = {}

  if (query.adminId) where.adminUserId = query.adminId
  if (query.action) where.action = query.action
  if (query.fromDate || query.toDate) {
    where.createdAt = {
      ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
      ...(query.toDate ? { lte: toDateEndOfDay(query.toDate) } : {}),
    }
  }

  const [items, total] = await prisma.$transaction([
    prisma.adminLog.findMany({
      where,
      include: { admin: { select: { email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.adminLog.count({ where }),
  ])

  return {
    items: items.map(log => ({
      id: log.id,
      adminId: log.adminUserId,
      adminEmail: log.admin.email,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.detail ? { detail: log.detail } : null,
      createdAt: log.createdAt,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

export async function getOrderDetail(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { id: true, email: true } },
      merchant: { select: { id: true, name: true } },
      product: {
        select: { id: true, name: true, icon: true, type: true, price: true },
      },
      delivery: { select: { content: true, status: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return serializeAdminOrderDetail(order)
}

// ---- Merchant Management ----

export async function listMerchants(status?: string, q?: string, page = 1, pageSize = 20) {
  const where: Prisma.MerchantWhereInput = {}
  if (status) where.status = status
  if (q) where.name = { contains: q, mode: 'insensitive' }

  return prisma.merchant.findMany({
    where,
    include: { user: { select: { id: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
}

export async function getMerchantDetail(id: number) {
  const merchant = await prisma.merchant.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, email: true } },
      products: { select: { id: true, name: true, status: true } },
      _count: { select: { orders: true } },
    },
  })
  if (!merchant) throw notFound('商家不存在')
  return merchant
}

export async function approveMerchant(adminUserId: number, merchantId: number) {
  return prisma.$transaction(async tx => {
    const merchant = await tx.merchant.findUnique({ where: { id: merchantId } })
    if (!merchant) throw notFound('商家不存在')
    if (merchant.status !== 'pending') throw badRequest('只能审核待审核的商家')

    const updated = await tx.merchant.update({
      where: { id: merchantId },
      data: { status: 'active', approvedAt: new Date(), approvedBy: adminUserId },
    })

    await tx.user.update({
      where: { id: merchant.userId },
      data: { role: 'merchant' },
    })

    await revokeAllUserRefreshTokens(merchant.userId, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '审核通过商家',
        targetType: 'merchant',
        targetId: merchantId,
        detail: `商家 ${merchant.name} 审核通过`,
      },
    })

    return updated
  })
}

export async function rejectMerchant(adminUserId: number, merchantId: number, reason?: string) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!merchant) throw notFound('商家不存在')
  if (merchant.status !== 'pending') throw badRequest('只能审核待审核的商家')

  const updated = await prisma.merchant.update({
    where: { id: merchantId },
    data: { status: 'rejected' },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '拒绝商家入驻',
      targetType: 'merchant',
      targetId: merchantId,
      detail: reason ? `拒绝原因: ${reason}` : undefined,
    },
  })

  return updated
}

export async function suspendMerchant(adminUserId: number, merchantId: number) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!merchant) throw notFound('商家不存在')
  if (merchant.status !== 'active') throw badRequest('只能停用已激活的商家')

  return prisma.$transaction(async tx => {
    const updated = await tx.merchant.update({
      where: { id: merchantId },
      data: { status: 'suspended' },
    })

    await tx.user.update({
      where: { id: merchant.userId },
      data: { role: 'user' },
    })

    await revokeAllUserRefreshTokens(merchant.userId, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '停用商家',
        targetType: 'merchant',
        targetId: merchantId,
        detail: `商家 ${merchant.name} 已停用`,
      },
    })

    return updated
  })
}

export async function updateCommission(adminUserId: number, merchantId: number, commissionRate: number) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!merchant) throw notFound('商家不存在')

  const updated = await prisma.merchant.update({
    where: { id: merchantId },
    data: { commissionRate },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '调整抽成比例',
      targetType: 'merchant',
      targetId: merchantId,
      detail: `抽成比例调整为 ${commissionRate}`,
    },
  })

  return updated
}

// ---- Settlements ----

export async function listAllSettlements(status?: string, page = 1, pageSize = 20) {
  const where: Prisma.SettlementWhereInput = {}
  if (status) where.status = status

  return prisma.settlement.findMany({
    where,
    include: {
      merchant: { select: { id: true, name: true } },
      order: { select: { id: true, price: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
}

export async function batchSettle(adminUserId: number, settlementIds: number[]) {
  return prisma.$transaction(async tx => {
    const settlements = await tx.settlement.findMany({
      where: { id: { in: settlementIds } },
      select: { id: true, status: true, order: { select: { status: true } } },
    })

    if (
      settlements.length !== settlementIds.length ||
      settlements.some(settlement => (
        settlement.status !== 'pending' ||
        !getSettlementEligibility(settlement.order.status).payable
      ))
    ) {
      throw badRequest('存在不可结算的记录')
    }

    const now = new Date()
    const result = await tx.settlement.updateMany({
      where: { id: { in: settlementIds }, status: 'pending' },
      data: { status: 'settled', settledAt: now },
    })

    if (result.count !== settlementIds.length) {
      throw badRequest('存在不可结算的记录')
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '批量结算',
        targetType: 'settlement',
        detail: `结算 ${result.count} 笔`,
      },
    })

    return { settled: result.count }
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
