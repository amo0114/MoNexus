import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import {
  getSystemConfigValue,
  listSystemConfigs,
  updateSystemConfig as saveSystemConfig,
} from '../../lib/systemConfig.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { createDefaultOffer, getDefaultOffer, syncProductProjection } from '../../lib/offers.js'
import { parseStoredDeliveryFields } from '../../lib/deliveryFields.js'
import {
  assertProductDeliveryConfiguration,
  normalizeProductImageFields,
} from '../../lib/productCommercial.js'
import {
  analyzeInventoryImport,
  duplicateInventoryImportDetails,
  isInventoryContentUniqueViolation,
  type InventoryImportPayload,
} from '../../lib/inventoryImport.js'
import { invalidate as invalidateUserStatusCache } from '../../lib/userStatusCache.js'
import { revokeAllUserRefreshTokens } from '../auth/service.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { serializeAdminOrderDetail, serializeAdminOrderList } from '../orders/serializers.js'
import { getSettlementEligibility } from '../merchant/service.js'
import { transitionOrderStatus } from '../orders/fulfillment.js'
import {
  creditAvailablePoints,
  refundPaidOrder,
  releaseHeldOrder,
  settleHeldOrder,
  voidRefundableSettlement,
} from '../orders/accounting.js'
import type {
  CreateProductInput,
  ListAdminAuditQuery,
  ListAnnouncementsQuery,
  ListOrdersQuery,
  ListUsersQuery,
  ResolveOrderInput,
  UpdateProductInput,
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from './schema.js'

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

    let newBalance: number
    if (type === 'add') {
      newBalance = await creditAvailablePoints(tx, targetUserId, amount)
    } else {
      const debited = await tx.pointAccount.updateMany({
        where: { userId: targetUserId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      })
      if (debited.count !== 1) {
        throw badRequest('扣除数量不能大于用户当前余额')
      }
      newBalance = (await tx.pointAccount.findUniqueOrThrow({ where: { userId: targetUserId } })).balance
    }

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

function productAuditSnapshot(product: {
  name: string
  type: string
  icon: string
  imageUrl: string | null
  images: string[]
  price: number
  originalPrice: number | null
  stock: number
  isHot: boolean
  status: string
  deliveryMode: string
  stockMode: string
  fixedContentType: string
}) {
  // Descriptions and image URLs are deliberately omitted. Audit needs to
  // explain commercial changes without copying arbitrary rich content.
  return {
    name: product.name,
    type: product.type,
    icon: product.icon,
    imageCount: product.images.length,
    price: product.price,
    originalPrice: product.originalPrice,
    stock: product.stock,
    isHot: product.isHot,
    status: product.status,
    deliveryMode: product.deliveryMode,
    stockMode: product.stockMode,
    fixedContentType: product.fixedContentType,
  }
}

function assertOriginalPriceAtLeastSale(price: number, originalPrice: number | null | undefined) {
  if (originalPrice != null && originalPrice < price) {
    throw badRequest('原价不能低于售价')
  }
}

export async function createProduct(adminUserId: number, data: CreateProductInput) {
  assertOriginalPriceAtLeastSale(data.price, data.originalPrice)
  const normalizedProductData = normalizeProductImageFields(data)
  const deliveryMode = data.deliveryMode ?? 'instant_inventory'
  const stockMode = data.stockMode ?? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
  const fixedContentType = data.fixedContentType ?? 'text'

  assertProductDeliveryConfiguration({
    deliveryMode,
    stockMode,
    incomingStock: data.stock,
    effectiveStock: data.stock,
    fixedContent: data.fixedContent,
    fixedContentType,
  })

  const product = await prisma.$transaction(async tx => {
    const created = await tx.product.create({
      data: {
        ...normalizedProductData,
        deliveryMode,
        stockMode,
        fixedContentType,
        stock: deliveryMode === 'instant_inventory' ? 0 : (data.stock ?? 0),
      },
    })
    // P4a：Offer 是价格/履约配置真相源，商品创建时同事务生成默认 Offer。
    await createDefaultOffer(tx, created.id, {
      price: data.price,
      originalPrice: data.originalPrice ?? null,
      deliveryMode,
      stockMode,
      stock: deliveryMode === 'instant_inventory' ? 0 : (data.stock ?? 0),
      fixedContent: data.fixedContent ?? null,
      fixedContentType,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '创建商品',
        targetType: 'product',
        targetId: created.id,
        detail: JSON.stringify({ after: productAuditSnapshot(created) }),
      },
    })
    return created
  })
  await invalidateProductPublicCache(product.id, { list: true })
  return product
}

export async function updateProduct(adminUserId: number, id: number, data: UpdateProductInput) {
  const updated = await prisma.$transaction(async tx => {
    const product = await tx.product.findUnique({ where: { id } })
    if (!product) throw notFound('商品不存在')

    assertOriginalPriceAtLeastSale(
      data.price ?? product.price,
      data.originalPrice === undefined ? product.originalPrice : data.originalPrice
    )

    const normalizedProductData = normalizeProductImageFields(data, product.images)
    const deliveryMode = normalizedProductData.deliveryMode ?? product.deliveryMode
    if (deliveryMode !== product.deliveryMode) {
      const [inventoryCount, orderCount] = await Promise.all([
        tx.inventoryItem.count({ where: { productId: id } }),
        tx.order.count({ where: { productId: id } }),
      ])
      if (inventoryCount > 0 || orderCount > 0) {
        throw badRequest('商品已有库存记录或订单，不能修改履约模式')
      }
    }

    const stockMode = normalizedProductData.stockMode
      ?? (normalizedProductData.deliveryMode && deliveryMode !== product.deliveryMode
        ? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
        : product.stockMode)
    const incomingStock = typeof normalizedProductData.stock === 'number' ? normalizedProductData.stock : undefined

    if (!('fixedContent' in normalizedProductData) && product.fixedContent != null && deliveryMode !== 'instant_fixed') {
      throw badRequest('切换交付模式请同时将 fixedContent 置空（传 null）')
    }

    assertProductDeliveryConfiguration({
      deliveryMode,
      stockMode,
      incomingStock,
      effectiveStock: incomingStock ?? product.stock,
      fixedContent: 'fixedContent' in normalizedProductData
        ? normalizedProductData.fixedContent
        : product.fixedContent,
      fixedContentType: normalizedProductData.fixedContentType ?? product.fixedContentType,
    })

    const next = await tx.product.update({
      where: { id },
      data: {
        ...normalizedProductData,
        deliveryMode,
        stockMode,
        ...(deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
          ? { stock: 0 }
          : {}),
      },
    })
    // P4a：商品级编辑写透到默认 Offer（真相源），随后投影同步对齐商业列。
    const defaultOffer = await getDefaultOffer(tx, id)
    await tx.offer.update({
      where: { id: defaultOffer.id },
      data: {
        ...(typeof data.price === 'number' ? { price: data.price } : {}),
        ...(data.originalPrice !== undefined ? { originalPrice: data.originalPrice } : {}),
        deliveryMode,
        stockMode,
        ...('fixedContent' in normalizedProductData
          ? { fixedContent: normalizedProductData.fixedContent as string | null }
          : {}),
        ...(normalizedProductData.fixedContentType != null
          ? { fixedContentType: normalizedProductData.fixedContentType as string }
          : {}),
        ...(incomingStock !== undefined ? { stock: incomingStock } : {}),
        ...(deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
          ? { stock: 0 }
          : {}),
      },
    })
    await syncProductProjection(tx, id)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新商品',
        targetType: 'product',
        targetId: id,
        detail: JSON.stringify({
          changedFields: Object.keys(data),
          before: productAuditSnapshot(product),
          after: productAuditSnapshot(next),
        }),
      },
    })
    return next
  })
  await invalidateProductPublicCache(updated.id, { detail: true, list: true })
  return updated
}

/**
 * P4a F2：管理端导入的规格解析。显式 offerId 必须属于该商品且是即时库存
 * 规格；缺省先落默认 Offer，默认非即时库存时回退到唯一的即时库存规格
 * （零个 → 商品不支持库存导入；多个 → 无法猜测意图，要求显式指定）。
 */
async function resolveAdminImportOffer(
  tx: Prisma.TransactionClient,
  productId: number,
  offerId: number | undefined
) {
  if (offerId != null) {
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')
    if (offer.deliveryMode !== 'instant_inventory') {
      throw badRequest('仅即时库存发货规格支持库存导入')
    }
    return offer
  }
  const defaultOffer = await getDefaultOffer(tx, productId)
  if (defaultOffer.deliveryMode === 'instant_inventory') return defaultOffer
  const instantOffers = await tx.offer.findMany({
    where: { productId, deliveryMode: 'instant_inventory' },
    orderBy: { id: 'asc' },
    take: 2,
  })
  if (instantOffers.length === 0) throw badRequest('仅即时库存发货商品支持库存管理')
  if (instantOffers.length > 1) throw badRequest('该商品有多个即时库存规格，请指定 offerId')
  return instantOffers[0]
}

export async function importInventory(
  productId: number,
  payload: InventoryImportPayload & { offerId?: number },
  adminUserId: number
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')

  try {
    const result = await prisma.$transaction(async tx => {
      const offer = await resolveAdminImportOffer(tx, productId, payload.offerId)
      // P4b：带交付字段模板的规格必须走商家端结构化导入（逐字段校验 + 快照）；
      // 管理端纯文本导入会破坏"模板规格库存必有 structuredContent"的契约。
      if (parseStoredDeliveryFields(offer.deliveryFields).length > 0) {
        throw badRequest('该规格配置了交付字段模板，请使用商家端按模板导入')
      }
      const analysis = await analyzeInventoryImport(productId, payload, tx)
      if (analysis.duplicateRows > 0 || analysis.existingDuplicateRows > 0) {
        throw badRequest('库存导入包含重复项', duplicateInventoryImportDetails(analysis))
      }
      if (analysis.validRows === 0) {
        throw badRequest('至少提供一条有效库存')
      }

      await tx.inventoryItem.createMany({
        data: analysis.itemsToImport.map(content => ({ productId, offerId: offer.id, content })),
      })

      await logInventoryChange(tx, {
        productId,
        offerId: offer.id,
        merchantId: product.merchantId,
        actorUserId: adminUserId,
        action: 'import',
        delta: analysis.itemsToImport.length,
        batchId: randomUUID(),
      })

      await tx.adminLog.create({
        data: {
          adminUserId,
          action: '导入库存',
          targetType: 'product',
          targetId: productId,
          detail: `导入 ${analysis.itemsToImport.length} 条库存`,
        },
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

    await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
    return result
  } catch (error) {
    // 与商家导入一样，数据库唯一索引是并发导入时的最终裁决；任何冲突
    // 都会使本事务完整回滚，并返回稳定的业务错误。
    if (isInventoryContentUniqueViolation(error)) {
      throw badRequest('库存导入包含重复项', [
        { field: 'items', message: 'existingDuplicateRows=concurrent' },
      ])
    }
    throw error
  }
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
        product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true } },
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
        select: { id: true, name: true, icon: true, type: true, imageUrl: true, price: true },
      },
      delivery: { select: { content: true, status: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  return serializeAdminOrderDetail(order)
}

// ---- Order Arbitration ----
//
// PRD §4.3.1：disputed 订单由管理员仲裁，结果为 refunded 时回滚冻结积分到用户余额，
// Settlement 设为 voided；结果为 close 时扣减冻结积分，Settlement 从 holding 转为 pending。
export async function resolveOrder(
  adminUserId: number,
  orderId: number,
  input: ResolveOrderInput
) {
  await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        userId: true,
        price: true,
        holdingPoints: true,
        fundsHeld: true,
      },
    })
    if (!order) throw notFound('订单不存在')
    if (order.status !== 'disputed') throw badRequest('仅争议中的订单可仲裁')

    const toStatus = input.result === 'refund' ? 'refunded' : 'closed'
    const action = input.result === 'refund' ? 'admin.resolve.refund' : 'admin.resolve.close'
    const publicNote = input.result === 'refund'
      ? '管理员仲裁：退款，积分已退还'
      : '管理员仲裁：关闭，积分已扣减'

    // Claim any unsettled merchant amount before changing the order state.  A
    // pending settlement cannot race ahead and be paid after a refund.
    if (input.result === 'refund') {
      await voidRefundableSettlement(tx, order.id)
    }

    await transitionOrderStatus(
      {
        orderId,
        toStatus,
        actorRole: 'admin',
        actorUserId: adminUserId,
        action,
        publicNote: input.note ? `${publicNote}（${input.note}）` : publicNote,
        internalNote: input.note,
      },
      tx
    )

    if (input.result === 'refund') {
      if (order.holdingPoints != null && order.holdingPoints > 0) {
        await releaseHeldOrder(tx, order, `管理员仲裁释放冻结积分: #${order.id}`)
      } else {
        await refundPaidOrder(tx, order, `管理员仲裁退款: #${order.id}`)
      }
    } else {
      await settleHeldOrder(tx, order, `管理员仲裁扣款: #${order.id}`)
      await tx.order.update({
        where: { id: orderId },
        data: { confirmedAt: new Date() },
      })
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: input.result === 'refund' ? '仲裁退款' : '仲裁关闭',
        targetType: 'order',
        targetId: orderId,
        detail: input.note ? `仲裁结果: ${input.result}，备注: ${input.note}` : `仲裁结果: ${input.result}`,
      },
    })
  })

  return getOrderDetail(orderId)
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

// ---- Announcements ----
//
// PRD §4.3.4：运营自助。公告支持 audience 分发（all/user/merchant/admin）、
// priority 倒序、时间窗口（startsAt/endsAt）、状态（draft/published/archived）。

function serializeAnnouncement(a: {
  id: number
  title: string
  content: string
  audience: string
  priority: number
  presentation: string
  maxImpressions: number
  version: number
  startsAt: Date
  endsAt: Date | null
  status: string
  createdBy: number | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    audience: a.audience,
    priority: a.priority,
    presentation: a.presentation,
    maxImpressions: a.maxImpressions,
    version: a.version,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt ? a.endsAt.toISOString() : null,
    status: a.status,
    createdBy: a.createdBy,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

export async function createAnnouncement(adminUserId: number, input: CreateAnnouncementInput) {
  const created = await prisma.announcement.create({
    data: {
      title: input.title,
      content: input.content,
      audience: input.audience,
      priority: input.priority,
      presentation: input.presentation,
      maxImpressions: input.maxImpressions,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      status: input.status,
      createdBy: adminUserId,
    },
  })
  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '创建公告',
      targetType: 'announcement',
      targetId: created.id,
      detail: `标题: ${input.title}，受众: ${input.audience}，展示: ${input.presentation}，状态: ${input.status}`,
    },
  })
  return serializeAnnouncement(created)
}

export async function updateAnnouncement(adminUserId: number, id: number, input: UpdateAnnouncementInput) {
  return prisma.$transaction(async tx => {
    const existing = await tx.announcement.findUnique({ where: { id } })
    if (!existing) throw notFound('公告不存在')

    const startsAt = input.startsAt ?? existing.startsAt
    const endsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt
    if (endsAt && endsAt < startsAt) {
      throw badRequest('结束时间必须晚于开始时间')
    }

    const data: Prisma.AnnouncementUpdateInput = {}
    if (input.title !== undefined) data.title = input.title
    if (input.content !== undefined) data.content = input.content
    if (input.audience !== undefined) data.audience = input.audience
    if (input.priority !== undefined) data.priority = input.priority
    if (input.presentation !== undefined) data.presentation = input.presentation
    if (input.maxImpressions !== undefined) data.maxImpressions = input.maxImpressions
    if (input.startsAt !== undefined) data.startsAt = input.startsAt
    if (input.endsAt !== undefined) data.endsAt = input.endsAt === null ? null : input.endsAt
    if (input.status !== undefined) data.status = input.status

    // A version is a user-facing contract: when the message or its delivery
    // policy changes, previously read/confirmed receipts must not suppress the
    // revised announcement. No-op saves deliberately keep the current version.
    const hasMeaningfulChange =
      (input.title !== undefined && input.title !== existing.title) ||
      (input.content !== undefined && input.content !== existing.content) ||
      (input.audience !== undefined && input.audience !== existing.audience) ||
      (input.priority !== undefined && input.priority !== existing.priority) ||
      (input.presentation !== undefined && input.presentation !== existing.presentation) ||
      (input.maxImpressions !== undefined && input.maxImpressions !== existing.maxImpressions) ||
      (input.status !== undefined && input.status !== existing.status) ||
      (input.startsAt !== undefined && input.startsAt.getTime() !== existing.startsAt.getTime()) ||
      (input.endsAt !== undefined && (input.endsAt?.getTime() ?? null) !== (existing.endsAt?.getTime() ?? null))
    if (hasMeaningfulChange) data.version = { increment: 1 }

    const updated = await tx.announcement.update({ where: { id }, data })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新公告',
        targetType: 'announcement',
        targetId: id,
        detail: `字段: ${Object.keys(input).join(',')}`,
      },
    })
    return serializeAnnouncement(updated)
  })
}

export async function listAnnouncements(query: ListAnnouncementsQuery = { page: 1, pageSize: 20 }) {
  const where: Prisma.AnnouncementWhereInput = {}
  if (query.status) where.status = query.status
  if (query.audience) where.audience = query.audience

  const [total, items] = await prisma.$transaction([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ])
  return { items: items.map(serializeAnnouncement), total, page: query.page, pageSize: query.pageSize }
}

export async function deleteAnnouncement(adminUserId: number, id: number) {
  const existing = await prisma.announcement.findUnique({ where: { id } })
  if (!existing) throw notFound('公告不存在')
  await prisma.announcement.delete({ where: { id } })
  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '删除公告',
      targetType: 'announcement',
      targetId: id,
      detail: `标题: ${existing.title}`,
    },
  })
  return { deleted: id }
}
