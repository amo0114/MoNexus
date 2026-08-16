import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError, type ErrorCode } from '../../lib/httpError.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import {
  getSystemConfigValue,
  listSystemConfigs,
  updateSystemConfig as saveSystemConfig,
} from '../../lib/systemConfig.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { createDefaultOffer, getDefaultOffer, syncProductProjection } from '../../lib/offers.js'
import {
  callFakaPlanCatalog,
  callFakaSetPlanCapacity,
  fetchFakaCapacityForSku,
  getFakaCapacityForPublicRead,
  invalidateFakaCapacityCache,
  isFakaBridgeConfigured,
  normalizeFakaOfferIntegration,
  assertOfferProvisionMutex,
  onFakaOrderRefundedInTx,
  scheduleFakaRevokeAttempt,
  processFakaRevokeTask,
  processFakaBridgeTask,
  syncFakaExpiresAtFromRemote,
  isLeaseExpiredUtc,
} from '../../lib/fakaBridge/index.js'
import { parseStoredDeliveryFields, structuredContentToJson } from '../../lib/deliveryFields.js'
import {
  assertProductDeliveryConfiguration,
  normalizeProductImageFields,
} from '../../lib/productCommercial.js'
import {
  analyzeInventoryForOffer,
  assertConfirmableInventoryAnalysis,
  isInventoryContentUniqueViolation,
  type InventoryImportPayload,
} from '../../lib/inventoryImport.js'
import { invalidate as invalidateUserStatusCache } from '../../lib/userStatusCache.js'
import { revokeAllUserRefreshTokens } from '../auth/service.js'
import { lockUserRefreshSessionMutations } from '../auth/sessionService.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { resolveProductCategory } from '../catalog/resolver.js'
import { isPlatformPublicAssetUrl } from '../catalog/categorySchema.js'
import { CATALOG_ERROR_CODES, EXTERNAL_CATALOG_PROVIDER } from '../catalog/constants.js'
import {
  buildExternalCatalogRequestHash,
  fetchNormalizedFakaSource,
  normalizeExternalCatalogRequest,
  validateExternalCatalogIdempotencyKey,
  type ExternalCatalogRequestInput,
  type NormalizedFakaSource,
} from '../catalog/externalCatalog.js'
import { checkProductReadiness } from '../catalog/publicationReadiness.js'
import {
  publishProduct as publishCatalogProduct,
  unpublishProduct as unpublishCatalogProduct,
} from '../catalog/productPublication.js'
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
import { applyRefundInventoryPolicy } from '../orders/refundInventory.js'
import type {
  CreateProductInput,
  ListAdminAuditQuery,
  ListAnnouncementsQuery,
  ListDeliveryFilesQuery,
  ListFileGrantsQuery,
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

    await lockUserRefreshSessionMutations(tx, target.id)

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
    status: product.status,
    deliveryMode: product.deliveryMode,
    stockMode: product.stockMode,
    fixedContentType: product.fixedContentType,
  }
}

/**
 * D-MERCH-01：Product.isHot 是遗留只读列，不进入任何商家/管理端 wire DTO
 * 与审计快照；公开投影的 isHot 由 merchandising run 计算。
 * 仅用于剥离 create/update 直接返回的 Prisma Product 行，不改变持久化。
 */
function stripLegacyIsHot<T extends { isHot: boolean }>(product: T): Omit<T, 'isHot'> {
  const { isHot: _legacyIsHot, ...rest } = product
  return rest
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
    incomingStock: undefined,
    effectiveStock: 0,
    fixedContent: data.fixedContent,
    fixedContentType,
  })

  const faka = normalizeFakaOfferIntegration({
    externalIntegration: data.externalIntegration,
    externalSku: data.externalSku,
    deliveryMode,
  })
  // 平台自营创建：默认 autoProvision=false；仍显式校验与 faka 互斥。
  assertOfferProvisionMutex({
    autoProvision: false,
    externalIntegration: faka.externalIntegration,
  })
  // Strip faka fields from product row (they live only on Offer).
  const {
    categoryId: _categoryId, type: _type,
    externalIntegration: _ei,
    externalSku: _es,
    ...productRowFields
  } = normalizedProductData as typeof normalizedProductData & {
    externalIntegration?: string | null
    externalSku?: string | null
    categoryId?: number
    type?: string
  }

  const product = await prisma.$transaction(async tx => {
    // B_CAT：用事务内 client 解析 categoryId/type（不开启嵌套事务）。
    const { categoryId, type } = await resolveProductCategory(
      { categoryId: data.categoryId, type: data.type },
      tx,
    )
    const created = await tx.product.create({
      data: {
        ...productRowFields,
        categoryId,
        type,
        deliveryMode,
        stockMode,
        fixedContentType,
        stock: 0,
        status: 'draft',
        merchantId: null,
      },
    })
    // P4a：Offer 是价格/履约配置真相源，商品创建时同事务生成默认 Offer。
    await createDefaultOffer(tx, created.id, {
      price: data.price,
      originalPrice: data.originalPrice ?? null,
      deliveryMode,
      stockMode,
      stock: 0,
      fixedContent: data.fixedContent ?? null,
      fixedContentType,
      externalIntegration: faka.externalIntegration,
      externalSku: faka.externalSku,
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
  // 返回边界最小剥离：wire DTO 不携带遗留 Product.isHot（D-MERCH-01）。
  return stripLegacyIsHot(product)
}

export async function getProductReadiness(productId: number) {
  return checkProductReadiness(productId)
}

export async function publishProduct(productId: number) {
  return publishCatalogProduct(productId)
}

export async function unpublishProduct(productId: number) {
  return unpublishCatalogProduct(productId)
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
    const incomingStock: number | undefined = undefined

    if (!('fixedContent' in normalizedProductData) && product.fixedContent != null && deliveryMode !== 'instant_fixed') {
      throw badRequest('切换交付模式请同时将 fixedContent 置空（传 null）')
    }

    // P5：与商家路径同规则——file 形态的交付配置只能走规格管理。
    const isFileFormProjection = product.fixedContentType === 'file'
    if (isFileFormProjection && (
      normalizedProductData.deliveryMode != null
      || 'fixedContent' in normalizedProductData
      || normalizedProductData.fixedContentType != null
    )) {
      throw badRequest('文件交付规格的交付配置请在「规格管理」中修改')
    }
    const fileFormDefaultOffer = isFileFormProjection ? await getDefaultOffer(tx, id) : null

    assertProductDeliveryConfiguration({
      deliveryMode,
      stockMode,
      incomingStock,
      effectiveStock: product.stock,
      fixedContent: 'fixedContent' in normalizedProductData
        ? normalizedProductData.fixedContent
        : product.fixedContent,
      fixedContentType: normalizedProductData.fixedContentType ?? product.fixedContentType,
      fixedFileId: fileFormDefaultOffer?.fixedFileId ?? null,
      allowFileForm: isFileFormProjection,
    })

    const {
      externalIntegration: _updateEi,
      externalSku: _updateEs,
      ...productUpdateFields
    } = normalizedProductData as typeof normalizedProductData & {
      externalIntegration?: string | null
      externalSku?: string | null
    }

    const fakaFieldsTouched = 'externalIntegration' in data || 'externalSku' in data
    const defaultOfferForFaka = await getDefaultOffer(tx, id)
    const fakaUpdate = fakaFieldsTouched || defaultOfferForFaka.externalIntegration != null
      ? normalizeFakaOfferIntegration(
          {
            externalIntegration: fakaFieldsTouched
              ? ('externalIntegration' in data
                  ? data.externalIntegration
                  : defaultOfferForFaka.externalIntegration)
              : defaultOfferForFaka.externalIntegration,
            externalSku: fakaFieldsTouched
              ? ('externalSku' in data ? data.externalSku : defaultOfferForFaka.externalSku)
              : defaultOfferForFaka.externalSku,
            deliveryMode,
          },
          {
            requireConfigured:
              (fakaFieldsTouched
                ? ('externalIntegration' in data
                    ? data.externalIntegration
                    : defaultOfferForFaka.externalIntegration)
                : defaultOfferForFaka.externalIntegration) === 'faka_bridge',
          }
        )
      : null

    const next = await tx.product.update({
      where: { id },
      data: {
        ...productUpdateFields,
        deliveryMode,
        stockMode,
        ...(deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
          ? { stock: 0 }
          : {}),
      },
    })
    // P4a：商品级编辑写透到默认 Offer（真相源），随后投影同步对齐商业列。
    const defaultOffer = defaultOfferForFaka
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
        ...(fakaUpdate
          ? {
              externalIntegration: fakaUpdate.externalIntegration,
              externalSku: fakaUpdate.externalSku,
            }
          : {}),
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
  // 返回边界最小剥离：wire DTO 不携带遗留 Product.isHot（D-MERCH-01）。
  return stripLegacyIsHot(updated)
}

/**
 * P4a F2：管理端导入的规格解析。显式 offerId 必须属于该商品且是即时库存
 * 规格；缺省先落默认 Offer，默认非即时库存时回退到唯一的即时库存规格
 * （零个 → 商品不支持库存导入；多个 → 无法猜测意图，要求显式指定）。
 */
type AdminInventoryClient = typeof prisma | Prisma.TransactionClient

async function resolveAdminImportOffer(
  tx: AdminInventoryClient,
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

/**
 * Admin preview（D-CAT-15）：与商家共用 lib 领域分析器，返回一致统计/错误语义
 * （AC-CAT-009）。Preview 零业务写入。
 */
async function previewAdminOfferInventory(
  productId: number,
  offer: { id: number; deliveryFields: unknown },
  payload: InventoryImportPayload
) {
  const analysis = await analyzeInventoryForOffer(productId, offer, payload)
  if ('rowErrors' in analysis) {
    return {
      offerId: offer.id,
      totalRows: analysis.totalRows,
      validRows: analysis.validRows,
      emptyRows: analysis.emptyRows,
      duplicateRows: analysis.duplicateRows,
      existingDuplicateRows: analysis.existingDuplicateRows,
      rowErrors: analysis.rowErrors,
      canImport: analysis.canImport,
      // 预览表格：模板 + 前 20 行解析结果（值不落库前仅回显给上传者本人）。
      structured: {
        fields: parseStoredDeliveryFields(offer.deliveryFields),
        rows: analysis.itemsToImport.slice(0, 20).map(item => item.structuredContent.values),
      },
    }
  }
  return {
    offerId: offer.id,
    totalRows: analysis.totalRows,
    validRows: analysis.validRows,
    emptyRows: analysis.emptyRows,
    duplicateRows: analysis.duplicateRows,
    existingDuplicateRows: analysis.existingDuplicateRows,
    canImport: analysis.canImport,
  }
}

export async function previewInventory(
  productId: number,
  payload: InventoryImportPayload & { offerId?: number }
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')
  // 旧兼容路径：未指定 offerId 时按既有回退规则解析即时库存规格。
  const offer = await resolveAdminImportOffer(prisma, productId, payload.offerId)
  return previewAdminOfferInventory(productId, offer, payload)
}

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：admin preview 显式 offerId。 */
export async function previewOfferInventory(
  productId: number,
  offerId: number,
  payload: InventoryImportPayload
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')
  const offer = await resolveAdminImportOffer(prisma, productId, offerId)
  return previewAdminOfferInventory(productId, offer, payload)
}

/** confirm 事务内重算核心（Admin）：与商家共用分析器与确认校验；另写 AdminLog（D-CAT-15）。 */
async function confirmAdminOfferInventoryImport(
  tx: Prisma.TransactionClient,
  productId: number,
  offer: { id: number; deliveryFields: unknown },
  merchantId: number | null,
  adminUserId: number,
  payload: InventoryImportPayload
) {
  const analysis = await analyzeInventoryForOffer(productId, offer, payload, tx)
  assertConfirmableInventoryAnalysis(analysis)

  await tx.inventoryItem.createMany({
    data: analysis.itemsToImport.map(item =>
      typeof item === 'string'
        ? { productId, offerId: offer.id, content: item }
        : {
            productId,
            offerId: offer.id,
            content: item.content,
            structuredContent: structuredContentToJson(item.structuredContent),
          }
    ),
  })

  await logInventoryChange(tx, {
    productId,
    offerId: offer.id,
    merchantId,
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
      detail: `offerId=${offer.id}; 导入 ${analysis.itemsToImport.length} 条库存`,
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
      // 旧兼容路径：未指定 offerId 时按既有回退规则解析即时库存规格。
      const offer = await resolveAdminImportOffer(tx, productId, payload.offerId)
      return confirmAdminOfferInventoryImport(tx, productId, offer, product.merchantId, adminUserId, payload)
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

/** 新 Offer-first 路径（T-CAT-BE-004，D-CAT-12/13）：admin 导入显式 offerId。 */
export async function importOfferInventory(
  productId: number,
  offerId: number,
  payload: InventoryImportPayload,
  adminUserId: number
) {
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw notFound('商品不存在')

  try {
    const result = await prisma.$transaction(async tx => {
      const offer = await resolveAdminImportOffer(tx, productId, offerId)
      return confirmAdminOfferInventoryImport(tx, productId, offer, product.merchantId, adminUserId, payload)
    })

    await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
    return result
  } catch (error) {
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
        // P6：仲裁需要订阅到期视角——只选 expiresAt（序列化补 expired），内容仍不出列表。
        delivery: { select: { status: true, expiresAt: true } },
        // P7b：列表徽标需要任务态安全投影（复审 P2：UI 已渲染，select 必须跟上）。
        provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
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
      // P6：详情补订阅到期时刻，供仲裁判断交付是否仍在有效期内。
      delivery: { select: { content: true, status: true, expiresAt: true } },
      // P7b：仲裁上下文透出自动开通任务态 + 脱敏诊断码（安全投影）。
      provisionTask: { select: { status: true, attempts: true, lastError: true, lastHttpStatus: true, nextAttemptAt: true, merchantNotifiedAt: true, updatedAt: true } },
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
    // 复审二 P1：事务起点先锁订单行，再读取校验。仲裁退款此前的写序是
    // Offer/Product（回补策略）→ Order（状态迁移），而续费下单是 Order
    // （原单 FOR UPDATE）→ Offer/Product（销量/库存）——disputed 的订阅
    // 原单仍可续费，两条路径并发即 Order↔Offer 循环等待死锁。统一为
    // "先锁 Order 再碰 Offer/Product"后，续费与仲裁在原单行上串行化。
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        userId: true,
        price: true,
        holdingPoints: true,
        fundsHeld: true,
        // P5.5 T4：退款回补策略需要的履约快照与归属字段。
        productId: true,
        offerId: true,
        merchantId: true,
        deliveryModeSnapshot: true,
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
      // P5.5 T4：仲裁退款的库存侧效果与积分退还/结算作废同事务——已交付
      // （disputed 只能来自 delivered）：卡密报废、销量净减、不回补容量。
      await applyRefundInventoryPolicy(tx, order, {
        fromStatus: 'disputed',
        actorUserId: adminUserId,
      })
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
      // FakaBridge：取消未开通任务 / 排队撤销已开通 Xboard 订阅
      await onFakaOrderRefundedInTx(tx, orderId)
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

  // Kick revoke worker outside the transaction
  if (input.result === 'refund') {
    const task = await prisma.fakaBridgeTask.findUnique({
      where: { orderId },
      select: { id: true, revokeStatus: true },
    })
    if (task?.revokeStatus === 'pending') {
      scheduleFakaRevokeAttempt(task.id)
    }
  }

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

    await lockUserRefreshSessionMutations(tx, merchant.userId)

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
    await lockUserRefreshSessionMutations(tx, merchant.userId)

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

/**
 * Admin batch-settle: mark Settlement pending→settled AND credit the merchant
 * owner account (settlementAmount). Previously only flipped status, so merchants
 * saw "已结算" with no points — that was a product bug.
 *
 * Idempotency: only rows with status=pending are selected and credited once
 * under the same transaction as the status CAS.
 */
export async function batchSettle(adminUserId: number, settlementIds: number[]) {
  return prisma.$transaction(async tx => {
    const settlements = await tx.settlement.findMany({
      where: { id: { in: settlementIds } },
      select: {
        id: true,
        status: true,
        orderId: true,
        settlementAmount: true,
        merchantId: true,
        order: { select: { status: true } },
        merchant: { select: { userId: true, name: true } },
      },
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
    let creditedTotal = 0

    // Row-by-row CAS so we never double-credit under concurrent batch calls.
    for (const settlement of settlements) {
      const claimed = await tx.settlement.updateMany({
        where: { id: settlement.id, status: 'pending' },
        data: { status: 'settled', settledAt: now },
      })
      if (claimed.count !== 1) {
        throw badRequest('存在不可结算的记录')
      }

      const amount = settlement.settlementAmount
      if (amount > 0) {
        const merchantUserId = settlement.merchant.userId
        // Ensure merchant owner has a point account (legacy rows).
        await tx.pointAccount.upsert({
          where: { userId: merchantUserId },
          create: { userId: merchantUserId, balance: 0 },
          update: {},
        })
        const balanceAfter = await creditAvailablePoints(tx, merchantUserId, amount)
        await tx.pointLog.create({
          data: {
            userId: merchantUserId,
            type: 'in',
            amount,
            balanceAfter,
            reason: `商家结算入账: 订单#${settlement.orderId}`,
            orderId: settlement.orderId,
          },
        })
        creditedTotal += amount
      }
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '批量结算',
        targetType: 'settlement',
        detail: `结算 ${settlements.length} 笔，入账合计 ${creditedTotal} 积分`,
      },
    })

    return { settled: settlements.length, creditedTotal }
  })
}

export async function listAdminProducts() {
  const products = await prisma.product.findMany({
    include: {
      _count: {
        select: { inventory: { where: { status: 'available' } } },
      },
      // P4a F2：导入弹窗需要知道每个商品有哪些即时库存规格（含已下架——
      // 重新上架前备货是合理操作）；deliveryFields 用于前端提示模板规格
      // 不能走管理端纯文本导入。管理端上下文，不含 fixedContent。
      offers: {
        select: {
          id: true,
          name: true,
          deliveryMode: true,
          status: true,
          isDefault: true,
          deliveryFields: true,
          externalIntegration: true,
          externalSku: true,
          stockMode: true,
          stock: true,
          price: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Attach Xboard capacity for Faka offers (admin-only read; not for merchants).
  const fakaSkus = [
    ...new Set(
      products.flatMap(p =>
        p.offers
          .filter(o => o.externalIntegration === 'faka_bridge' && o.externalSku)
          .map(o => String(o.externalSku).toLowerCase())
      )
    ),
  ]
  const capBySku = new Map<string, Awaited<ReturnType<typeof fetchFakaCapacityForSku>>>()
  if (isFakaBridgeConfigured() && fakaSkus.length > 0) {
    // Inventory overview is read-only: return the local capacity projection
    // immediately and let its shared SWR refresh run in the background.
    for (const sku of fakaSkus) {
      capBySku.set(sku, getFakaCapacityForPublicRead(sku))
    }
  }

  return products.map(p => {
    const offers = p.offers.map(o => {
      const sku = o.externalSku?.toLowerCase() ?? null
      const fakaCapacity =
        o.externalIntegration === 'faka_bridge' && sku ? capBySku.get(sku) ?? null : null
      return { ...o, fakaCapacity }
    })
    const primaryFaka = offers.find(o => o.fakaCapacity?.source === 'xboard')?.fakaCapacity ?? null
    // D-MERCH-01：显式剥离遗留 Product.isHot（...p 会带出），其余管理字段原样保留。
    const { isHot: _legacyIsHot, ...productDto } = p
    return {
      ...productDto,
      offers,
      fakaBridge: offers.some(o => o.externalIntegration === 'faka_bridge'),
      fakaCapacity: primaryFaka,
    }
  })
}

/**
 * Admin-only: set Xboard capacity_limit for a Faka offer (null = unlimited).
 * Merchants cannot call this route (requireAdmin on admin router).
 */
export async function setAdminFakaCapacity(
  adminUserId: number,
  productId: number,
  input: { offerId?: number; capacityLimit: number | null }
) {
  if (!isFakaBridgeConfigured()) {
    throw badRequest('平台未配置 FakaBridge')
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      offers: {
        select: {
          id: true,
          name: true,
          externalIntegration: true,
          externalSku: true,
          isDefault: true,
        },
      },
    },
  })
  if (!product) throw notFound('商品不存在')

  let offer = input.offerId
    ? product.offers.find(o => o.id === input.offerId)
    : product.offers.find(o => o.externalIntegration === 'faka_bridge' && o.isDefault) ??
      product.offers.find(o => o.externalIntegration === 'faka_bridge')

  if (!offer || offer.externalIntegration !== 'faka_bridge' || !offer.externalSku) {
    throw badRequest('该商品/规格未接入 FakaBridge')
  }

  const sku = offer.externalSku.toLowerCase()
  const res = await callFakaSetPlanCapacity(sku, input.capacityLimit)
  if (!res.ok || !res.body || res.body.success !== true) {
    const msg =
      res.body && typeof res.body === 'object' && 'error' in res.body
        ? String((res.body as { error?: string }).error)
        : '同步 Xboard 人数限制失败'
    throw badRequest(msg)
  }

  invalidateFakaCapacityCache(sku)

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '同步Xboard人数限制',
      targetType: 'product',
      targetId: productId,
      detail: JSON.stringify({
        offerId: offer.id,
        sku,
        capacityLimit: input.capacityLimit,
        after: res.body,
      }),
    },
  })

  await invalidateProductPublicCache(productId, { list: true, detail: true })

  return fetchFakaCapacityForSku(sku)
}

/** Admin-only: list Xboard plans for import. */
/**
 * Admin delete product:
 * - No orders → hard delete offers + product
 * - Has orders → soft delete (status=inactive); historical orders kept
 */
export async function deleteAdminProduct(adminUserId: number, productId: number) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, status: true },
  })
  if (!product) throw notFound('商品不存在')

  const orderCount = await prisma.order.count({ where: { productId } })

  if (orderCount > 0) {
    if (product.status === 'inactive') {
      throw badRequest('商品已下架，且存在历史订单，无法物理删除')
    }
    const updated = await prisma.$transaction(async tx => {
      const row = await tx.product.update({
        where: { id: productId },
        data: { status: 'inactive' },
      })
      await tx.offer.updateMany({
        where: { productId },
        data: { status: 'inactive' },
      })
      await tx.adminLog.create({
        data: {
          adminUserId,
          action: '下架商品',
          targetType: 'product',
          targetId: productId,
          detail: JSON.stringify({
            reason: '存在历史订单，仅下架',
            orderCount,
            name: product.name,
          }),
        },
      })
      return row
    })
    await invalidateProductPublicCache(productId, { list: true, detail: true })
    return { mode: 'soft' as const, productId, orderCount, status: updated.status }
  }

  // No orders: hard delete. Clear inventory/logs then offers then product.
  await prisma.$transaction(async tx => {
    await tx.inventoryItem.deleteMany({ where: { productId } })
    await tx.inventoryLog.deleteMany({ where: { productId } })
    await tx.offer.deleteMany({ where: { productId } })
    await tx.product.delete({ where: { id: productId } })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '删除商品',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({ name: product.name, mode: 'hard' }),
      },
    })
  })
  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return { mode: 'hard' as const, productId, orderCount: 0 }
}

export async function listAdminFakaCatalog() {
  if (!isFakaBridgeConfigured()) {
    throw badRequest('平台未配置 FakaBridge')
  }
  const res = await callFakaPlanCatalog()
  if (!res.ok || !res.body || res.body.success !== true) {
    const msg =
      res.body && typeof res.body === 'object' && 'error' in res.body
        ? String((res.body as { error?: string }).error)
        : '拉取 Xboard 套餐目录失败'
    throw badRequest(msg)
  }
  return { plans: res.body.plans }
}

const PERIOD_OFFER_LABELS: Record<string, string> = {
  monthly: '月付',
  quarterly: '季付',
  half_yearly: '半年付',
  yearly: '年付',
  two_yearly: '两年付',
  three_yearly: '三年付',
  // Xboard 后台「流量包」= prices.onetime（文案：一次性流量包，无时间限制）
  // → buyByOneTime：expired_at=null，写入套餐流量
  onetime: '流量包',
  // Xboard 后台「重置包」= prices.reset_traffic（文案：重置流量包，可多次使用）
  reset_traffic: '重置包',
}

/** 规格副标题（写入 Offer 名以外的展示由前端/导入说明承担） */
export const PERIOD_OFFER_HINTS: Record<string, string> = {
  monthly: '自交付起约 30 天',
  quarterly: '自交付起约 90 天',
  half_yearly: '自交付起约 180 天',
  yearly: '自交付起约 365 天',
  two_yearly: '自交付起约 730 天',
  three_yearly: '自交付起约 1095 天',
  onetime: '一次性流量包，无时间限制（对应 Xboard 流量包）',
  reset_traffic: '重置已用流量，可多次购买（对应 Xboard 重置包）',
}

const PERIOD_VALIDITY_DAYS: Record<string, number | null> = {
  monthly: 30,
  quarterly: 90,
  half_yearly: 180,
  yearly: 365,
  two_yearly: 730,
  three_yearly: 1095,
  // 永久 / 流量包：不展示「有效期 N 天」，避免与月付混淆
  onetime: null,
  reset_traffic: null,
}

type FakaImportOfferRow = {
  period: string
  sku?: string
  offerName?: string
  pricePoints: number
  validityDays?: number | null
}

/**
 * Resolve externalSku for a plan period.
 * Prefer explicit/named SKU; on capacity miss fall back to plan-{id}-{period}.
 * Does not hard-fail the whole import on a single flaky capacity probe when alias works.
 */
async function resolveFakaOfferSku(planId: number, period: string, skuHint?: string) {
  const candidates = [
    skuHint?.trim().toLowerCase(),
    `plan-${planId}-${period}`,
  ].filter((s, i, arr): s is string => Boolean(s) && arr.indexOf(s) === i)

  let lastReason = '无法确认 Xboard 套餐名额'
  for (const sku of candidates) {
    const cap = await fetchFakaCapacityForSku(sku)
    if (cap.source === 'xboard') {
      if (cap.planId != null && cap.planId !== planId) {
        lastReason = `SKU ${sku} 与 planId=${planId} 不匹配（解析到 plan ${cap.planId}）`
        continue
      }
      return { sku, cap }
    }
    lastReason = `SKU ${sku}：${cap.reason ?? lastReason}`
  }

  // Catalog already listed this period — allow import with alias even if capacity
  // probe is flaky (cached unavailable / network). Order path will re-check.
  const alias = `plan-${planId}-${period}`
  return {
    sku: candidates[0] ?? alias,
    cap: {
      sku: candidates[0] ?? alias,
      planId,
      capacityLimit: null,
      activeUsers: null,
      remaining: null,
      sellable: true,
      source: 'unavailable' as const,
      reason: lastReason,
    },
  }
}

const FAKA_PURCHASE_FORM = [
  {
    key: 'xboardEmail',
    label: 'Xboard 开通邮箱',
    type: 'text' as const,
    required: true,
    placeholder: '已有面板账号填该邮箱；没有则填要注册的邮箱',
  },
]

type FakaImportDb = typeof prisma | Prisma.TransactionClient

type FakaImportIssue = { code: string; field: string; message: string }

async function resolveFakaImportCover(
  db: FakaImportDb,
  input: ExternalCatalogRequestInput,
): Promise<{ imageUrl: string; images: string[] }> {
  const category = await db.productCategory.findUnique({
    where: { id: input.categoryId },
    select: { status: true, defaultCoverUrl: true },
  })
  if (!category || category.status !== 'active') throw badRequest('商品分类不存在或已停用')
  if (input.cover.mode === 'category_default') {
    const imageUrl = category.defaultCoverUrl
    if (!imageUrl || !isPlatformPublicAssetUrl(imageUrl)) {
      throw badRequest('该分类尚未配置可用默认封面')
    }
    return { imageUrl, images: [imageUrl] }
  }

  const images = (input.cover.images?.length ? input.cover.images : [input.cover.imageUrl])
    .map(value => value.trim())
  if (images[0] !== input.cover.imageUrl.trim()) throw badRequest('images 第一项必须与 imageUrl 一致')
  if (new Set(images).size !== images.length) throw badRequest('封面图片不能重复')
  for (const imageUrl of images) {
    if (!imageUrl.startsWith('/uploads/') || !isPlatformPublicAssetUrl(imageUrl)) {
      throw badRequest('上传封面必须来自平台 /uploads/ 公共对象')
    }
    const objectKey = imageUrl.slice('/uploads/'.length)
    const stored = await db.storedObject.findFirst({
      where: { bucketRole: 'public', objectKey, status: 'active', source: 'upload_image' },
      select: { id: true },
    })
    if (!stored) throw badRequest('上传封面不存在或已失效')
  }
  return { imageUrl: images[0]!, images }
}

async function analyzeAdminFakaImport(
  source: NormalizedFakaSource,
  input: ExternalCatalogRequestInput,
  db: FakaImportDb = prisma,
) {
  const request = normalizeExternalCatalogRequest(input)
  const issues: FakaImportIssue[] = []
  if (!source.capacity.sellable) {
    issues.push({ code: 'SOURCE_NOT_SELLABLE', field: 'planId', message: 'Xboard 套餐当前不可售或名额不足' })
  }
  if (request.offers.length === 0) {
    issues.push({ code: 'OFFER_REQUIRED', field: 'offers', message: '至少选择一个套餐周期' })
  }
  const periods = request.offers.map(row => row.period)
  if (new Set(periods).size !== periods.length) {
    issues.push({ code: 'PERIOD_DUPLICATE', field: 'offers', message: '套餐周期不能重复' })
  }
  const sourcePeriods = new Map(source.periods.map(row => [row.period, row]))
  const namedSkus = new Map(source.namedSkus.map(row => [row.period, row.sku]))
  const offers = request.offers.map(row => {
    const sourcePeriod = sourcePeriods.get(row.period)
    if (!sourcePeriod) {
      issues.push({ code: 'PERIOD_NOT_FOUND', field: 'offers', message: `Xboard 套餐不支持周期 ${row.period}` })
    }
    const sku = row.sku || namedSkus.get(row.period) || sourcePeriod?.skuAlias || `plan-${input.planId}-${row.period}`
    return {
      period: row.period,
      sku,
      offerName: row.offerName || PERIOD_OFFER_LABELS[row.period] || row.period,
      pricePoints: row.pricePoints,
      validityDays: row.validityDays === undefined
        ? (PERIOD_VALIDITY_DAYS[row.period] ?? null)
        : row.validityDays,
    }
  })
  const skus = offers.map(row => row.sku)
  if (new Set(skus).size !== skus.length) {
    issues.push({ code: 'SKU_DUPLICATE', field: 'offers', message: '规格 SKU 不能重复' })
  }
  if (skus.length > 0) {
    const conflicts = await db.offer.findMany({
      where: { externalIntegration: 'faka_bridge', externalSku: { in: skus } },
      select: { externalSku: true, productId: true },
    })
    for (const conflict of conflicts) {
      issues.push({
        code: 'SKU_ALREADY_IMPORTED',
        field: 'offers',
        message: `所选规格已关联商品 ${conflict.productId}`,
      })
    }
  }
  const linked = await db.externalCatalogLink.findUnique({
    where: {
      provider_externalProductId: {
        provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE,
        externalProductId: String(input.planId),
      },
    },
    select: { productId: true },
  })
  if (linked) {
    issues.push({ code: 'PLAN_ALREADY_IMPORTED', field: 'planId', message: `该套餐已关联商品 ${linked.productId}` })
  }

  let cover: { imageUrl: string; images: string[] } | null = null
  try {
    cover = await resolveFakaImportCover(db, input)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    issues.push({ code: 'COVER_INVALID', field: 'cover', message: error.message })
  }
  const productName = request.productName || source.name || `Xboard 套餐 #${input.planId}`
  const plainDescription = source.plainDescription || `${productName} · 含 ${offers.map(row => row.offerName).join(' / ')} 等规格`
  return {
    sourceHash: source.sourceHash,
    capacity: source.capacity,
    productName,
    plainDescription,
    richDescription: source.richDescription,
    cover,
    offers,
    issues,
    canConfirm: issues.length === 0 && cover !== null && offers.length > 0,
  }
}

/** Mandatory Xboard preview. It performs remote/DB reads but zero business writes. */
export async function previewAdminFakaPlan(input: ExternalCatalogRequestInput) {
  const source = await fetchNormalizedFakaSource(input.planId)
  return analyzeAdminFakaImport(source, input)
}

/**
 * Admin-only: create one product with one-or-more Faka offers (periods).
 * Same Xboard plan_id → multiple MoNexus offers (月付/年付…), like multi-SKU product page.
 */
export async function importAdminFakaPlan(
  adminUserId: number,
  input: ExternalCatalogRequestInput & { sourceHash: string },
  idempotencyKeyRaw?: string | null,
) {
  const key = validateExternalCatalogIdempotencyKey(idempotencyKeyRaw)
  const requestHash = buildExternalCatalogRequestHash(input, input.sourceHash)
  const existingByKey = await prisma.externalCatalogLink.findUnique({
    where: { provider_idempotencyKey: { provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE, idempotencyKey: key } },
    select: { productId: true, requestHash: true },
  })
  if (existingByKey) {
    if (existingByKey.requestHash !== requestHash) {
      throw new HttpError(409, CATALOG_ERROR_CODES.IDEMPOTENCY_KEY_REUSED as ErrorCode, '该幂等键已用于不同请求')
    }
    return { productId: existingByKey.productId, replayed: true }
  }

  const source = await fetchNormalizedFakaSource(input.planId)
  if (source.sourceHash !== input.sourceHash) {
    throw new HttpError(409, CATALOG_ERROR_CODES.FAKA_SOURCE_CHANGED as ErrorCode, 'Xboard 套餐已变化，请重新预览')
  }
  const existingByPlan = await prisma.externalCatalogLink.findUnique({
    where: {
      provider_externalProductId: {
        provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE,
        externalProductId: String(input.planId),
      },
    },
    select: { productId: true },
  })
  if (existingByPlan) {
    throw new HttpError(409, 'CONFLICT', '该 Xboard 套餐已导入', [
      { field: 'existingProductId', message: String(existingByPlan.productId) },
    ])
  }
  const analysis = await analyzeAdminFakaImport(source, input)
  if (!analysis.canConfirm || !analysis.cover) {
    throw badRequest('Xboard 导入尚未满足确认条件', analysis.issues.map(issue => ({ field: issue.field, message: `${issue.code}:${issue.message}` })))
  }

  try {
    const product = await prisma.$transaction(async tx => {
      // Confirm transaction repeats all mutable DB checks; no remote I/O occurs here.
      const transactional = await analyzeAdminFakaImport(source, input, tx)
      if (!transactional.canConfirm || !transactional.cover) {
        throw badRequest('Xboard 导入条件已变化', transactional.issues.map(issue => ({ field: issue.field, message: `${issue.code}:${issue.message}` })))
      }
      const { categoryId, type } = await resolveProductCategory({ categoryId: input.categoryId }, tx)
      const defaultRow = transactional.offers[0]!
      const created = await tx.product.create({
        data: {
          name: transactional.productName,
          description: transactional.plainDescription,
          richDescription: transactional.richDescription,
          categoryId,
          type,
          icon: 'package',
          imageUrl: transactional.cover.imageUrl,
          images: transactional.cover.images,
          price: defaultRow.pricePoints,
          deliveryMode: 'manual_service',
          stockMode: 'unlimited',
          stock: 0,
          isHot: false,
          status: 'draft',
          merchantId: null,
          purchaseForm: FAKA_PURCHASE_FORM,
        },
      })
      await createDefaultOffer(tx, created.id, {
        price: defaultRow.pricePoints,
        originalPrice: null,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        stock: 0,
        fixedContent: null,
        fixedContentType: 'text',
        validityDays: defaultRow.validityDays,
        externalIntegration: 'faka_bridge',
        externalSku: defaultRow.sku,
      }, defaultRow.offerName)
      for (let i = 1; i < transactional.offers.length; i++) {
        const row = transactional.offers[i]!
        await tx.offer.create({
          data: {
            productId: created.id,
            name: row.offerName,
            isDefault: false,
            price: row.pricePoints,
            originalPrice: null,
            deliveryMode: 'manual_service',
            stockMode: 'unlimited',
            stock: 0,
            fixedContent: null,
            fixedContentType: 'text',
            validityDays: row.validityDays,
            externalIntegration: 'faka_bridge',
            externalSku: row.sku,
            sortOrder: i,
            status: 'active',
          },
        })
      }
      await tx.externalCatalogLink.create({
        data: {
          provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE,
          externalProductId: String(input.planId),
          productId: created.id,
          sourceHash: source.sourceHash,
          sourceSnapshot: source.sourceSnapshot,
          idempotencyKey: key,
          requestHash,
          importedByUserId: adminUserId,
        },
      })
      await tx.adminLog.create({
        data: {
          adminUserId,
          action: '从Xboard导入商品草稿',
          targetType: 'product',
          targetId: created.id,
          detail: JSON.stringify({ planId: input.planId, offerCount: transactional.offers.length }),
        },
      })
      return created
    })
    await invalidateProductPublicCache(product.id, { list: true })
    return { productId: product.id, offerCount: analysis.offers.length, offers: analysis.offers, replayed: false }
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const link = await prisma.externalCatalogLink.findFirst({
      where: {
        provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE,
        OR: [{ idempotencyKey: key }, { externalProductId: String(input.planId) }],
      },
      select: { productId: true, idempotencyKey: true, requestHash: true },
    })
    if (link?.idempotencyKey === key && link.requestHash === requestHash) {
      return { productId: link.productId, replayed: true }
    }
    const skuConflict = link ? null : await prisma.offer.findFirst({
      where: { externalIntegration: 'faka_bridge', externalSku: { in: analysis.offers.map(row => row.sku) } },
      select: { productId: true },
    })
    const existingProductId = link?.productId ?? skuConflict?.productId
    throw new HttpError(409, 'CONFLICT', '该 Xboard 商品或规格已导入', existingProductId == null
      ? undefined
      : [{ field: 'existingProductId', message: String(existingProductId) }])
  }
}

/**
 * Admin-only: append more period SKUs to an existing Faka product.
 */
export async function addAdminFakaOffers(
  adminUserId: number,
  productId: number,
  input: { offers: FakaImportOfferRow[] }
) {
  if (!isFakaBridgeConfigured()) {
    throw badRequest('平台未配置 FakaBridge')
  }
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      offers: {
        select: {
          id: true,
          externalIntegration: true,
          externalSku: true,
          sortOrder: true,
        },
      },
    },
  })
  if (!product) throw notFound('商品不存在')

  const existingFaka = product.offers.filter(o => o.externalIntegration === 'faka_bridge')
  if (existingFaka.length === 0) {
    throw badRequest('该商品尚未接入 FakaBridge，请先导入套餐')
  }

  // Infer planId from an existing named/plan- sku
  let planId: number | null = null
  for (const o of existingFaka) {
    const m = o.externalSku?.match(/^plan-(\d+)-/)
    if (m) {
      planId = Number(m[1])
      break
    }
    if (o.externalSku) {
      const cap = await fetchFakaCapacityForSku(o.externalSku)
      if (cap.planId != null) {
        planId = cap.planId
        break
      }
    }
  }
  if (planId == null) {
    throw badRequest('无法从现有规格推断 Xboard planId')
  }

  const existingSkus = new Set(
    existingFaka.map(o => o.externalSku?.toLowerCase()).filter(Boolean) as string[]
  )
  const maxSort = product.offers.reduce((m, o) => Math.max(m, o.sortOrder ?? 0), 0)

  const resolved: Array<{
    period: string
    sku: string
    offerName: string
    pricePoints: number
    validityDays: number | null
    faka: ReturnType<typeof normalizeFakaOfferIntegration>
    cap: Awaited<ReturnType<typeof resolveFakaOfferSku>>['cap']
  }> = []
  for (const row of input.offers) {
    const period = row.period.trim().toLowerCase()
    const { sku, cap } = await resolveFakaOfferSku(planId, period, row.sku)
    if (existingSkus.has(sku)) {
      throw badRequest(`规格 SKU 已存在：${sku}`)
    }
    const faka = normalizeFakaOfferIntegration({
      externalIntegration: 'faka_bridge',
      externalSku: sku,
      deliveryMode: 'manual_service',
    })
    resolved.push({
      period,
      sku: faka.externalSku!,
      offerName: row.offerName?.trim() || PERIOD_OFFER_LABELS[period] || period,
      pricePoints: row.pricePoints,
      validityDays:
        row.validityDays !== undefined
          ? row.validityDays
          : (PERIOD_VALIDITY_DAYS[period] ?? null),
      faka,
      cap,
    })
    existingSkus.add(sku)
  }

  await prisma.$transaction(async tx => {
    for (let i = 0; i < resolved.length; i++) {
      const row = resolved[i]!
      await tx.offer.create({
        data: {
          productId,
          name: row.offerName,
          isDefault: false,
          price: row.pricePoints,
          deliveryMode: 'manual_service',
          stockMode: 'unlimited',
          stock: 0,
          validityDays: row.validityDays,
          externalIntegration: row.faka.externalIntegration,
          externalSku: row.faka.externalSku,
          sortOrder: maxSort + 1 + i,
          status: 'active',
        },
      })
    }
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '追加Xboard规格',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({
          planId,
          offers: resolved.map(r => ({ period: r.period, sku: r.sku, pricePoints: r.pricePoints })),
        }),
      },
    })
  })

  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return {
    productId,
    added: resolved.map(r => ({
      period: r.period,
      sku: r.sku,
      offerName: r.offerName,
      pricePoints: r.pricePoints,
    })),
  }
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

// ---- P5：交付文件治理 ----

/**
 * 吊销交付文件（违法/恶意内容）：买家与商家全部拒绝新签发（仅管理员可
 * 取证下载），挂载它的规格立即停售（下单事务检查 file.status）。行与对象
 * 都保留——退款与清理走各自流程，吊销本身不删任何东西。
 */
export async function revokeDeliveryFile(adminUserId: number, fileId: number, reason?: string) {
  const file = await prisma.deliveryFile.findUnique({
    where: { id: fileId },
    select: { id: true, status: true },
  })
  if (!file) throw notFound('文件不存在')
  if (file.status === 'deleted') throw badRequest('文件已清理，无法吊销')
  if (file.status === 'revoked') return { revoked: true }

  await prisma.$transaction(async tx => {
    await tx.deliveryFile.update({ where: { id: fileId }, data: { status: 'revoked' } })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '吊销交付文件',
        targetType: 'deliveryFile',
        targetId: fileId,
        detail: reason ?? '违规内容吊销',
      },
    })
  })
  return { revoked: true }
}

// ---- P5.5 T1：交付文件治理（列表 + 发放流水） ----

/**
 * 分页列出交付文件。P5 不变量：普通 API（管理端也算）永不返回对象 key/bucket，
 * 对账凭 sha256 已足够——select 白名单显式排除 key。引用计数（在售规格 /
 * 交付记录）用于评估吊销影响面。
 */
export async function listDeliveryFiles(query: ListDeliveryFilesQuery) {
  const where: Prisma.DeliveryFileWhereInput = {}
  if (query.merchantId) where.merchantId = query.merchantId
  if (query.status) where.status = query.status
  if (query.fileName) where.fileName = { contains: query.fileName, mode: 'insensitive' }

  const [items, total] = await prisma.$transaction([
    prisma.deliveryFile.findMany({
      where,
      select: {
        id: true,
        fileName: true,
        size: true,
        sha256: true,
        mimeType: true,
        status: true,
        createdAt: true,
        merchant: { select: { id: true, name: true } },
        _count: { select: { offers: true, deliveryRecords: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.deliveryFile.count({ where }),
  ])

  return {
    items: items.map(file => ({
      id: file.id,
      fileName: file.fileName,
      size: file.size,
      sha256: file.sha256,
      mimeType: file.mimeType,
      status: file.status,
      createdAt: file.createdAt,
      merchant: file.merchant,
      refCounts: { offers: file._count.offers, deliveryRecords: file._count.deliveryRecords },
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

/**
 * 某文件的签名发放流水（FileGrantLog，granted 与 denied 全记）。任意状态的
 * 文件都可查——deleted 文件的历史发放仍是审计事实。倒序走 [fileId, createdAt]
 * 索引。ipHash 是 HMAC 摘要（不可还原），可直接出给管理员做同源关联。
 */
export async function listDeliveryFileGrants(fileId: number, query: ListFileGrantsQuery) {
  const file = await prisma.deliveryFile.findUnique({ where: { id: fileId }, select: { id: true } })
  if (!file) throw notFound('文件不存在')

  const [items, total] = await prisma.$transaction([
    prisma.fileGrantLog.findMany({
      where: { fileId },
      select: {
        id: true,
        orderId: true,
        userId: true,
        role: true,
        outcome: true,
        ipHash: true,
        userAgent: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.fileGrantLog.count({ where: { fileId } }),
  ])

  return { items, total, page: query.page, pageSize: query.pageSize }
}

// ---- P5.5 T2：全平台热销规格报表 ----

const OFFER_REPORT_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const

interface AdminOfferReportRow {
  offerId: number | null
  productId: number
  merchantId: number | null
  offerName: string
  productName: string
  merchantName: string | null
  soldCount: number | bigint
  pointsRevenue: number | bigint | null
}

/**
 * 全平台热销规格 top-20。口径 = 净成交（排除 refunded）——`Offer.sales` 是
 * 只增计数器，不作报表数据源。按 (offerId, productId, merchantId) 分组：
 * 非空 offerId 本就唯一确定商品与商家，等价于按 offerId 分组；offerId IS NULL
 * 的历史单则按商品拆桶，保证 productId 列有确定含义。规格名优先取当前
 * Offer.name（改名即时生效），规格行缺失时回退最近一笔订单的 offerNameSnapshot，
 * NULL 桶固定为「未指定规格」。
 */
export async function getOfferReport(range: keyof typeof OFFER_REPORT_RANGE_DAYS) {
  const start = new Date(Date.now() - OFFER_REPORT_RANGE_DAYS[range] * 24 * 60 * 60 * 1000)

  const rows = await prisma.$queryRaw<AdminOfferReportRow[]>`
    SELECT
      o."offerId" AS "offerId",
      o."productId" AS "productId",
      o."merchantId" AS "merchantId",
      COALESCE(
        MAX(ofr."name"),
        (array_agg(o."offerNameSnapshot" ORDER BY o."createdAt" DESC, o."id" DESC)
          FILTER (WHERE o."offerNameSnapshot" IS NOT NULL))[1],
        '未指定规格'
      ) AS "offerName",
      MAX(p."name") AS "productName",
      MAX(m."name") AS "merchantName",
      COUNT(*)::int AS "soldCount",
      COALESCE(SUM(o."price"), 0)::int AS "pointsRevenue"
    FROM "Order" o
    INNER JOIN "Product" p ON p."id" = o."productId"
    LEFT JOIN "Offer" ofr ON ofr."id" = o."offerId"
    LEFT JOIN "Merchant" m ON m."id" = o."merchantId"
    WHERE o."createdAt" >= ${start}
      AND o."status" <> 'refunded'
    GROUP BY o."offerId", o."productId", o."merchantId"
    ORDER BY COALESCE(SUM(o."price"), 0) DESC, COUNT(*) DESC, o."productId" ASC, o."offerId" ASC NULLS LAST
    LIMIT 20
  `

  return {
    items: rows.map(row => ({
      offerId: row.offerId,
      offerName: row.offerName,
      productId: row.productId,
      productName: row.productName,
      merchantId: row.merchantId,
      merchantName: row.merchantName,
      soldCount: Number(row.soldCount ?? 0),
      pointsRevenue: Number(row.pointsRevenue ?? 0),
    })),
  }
}

// ---- FakaBridge task ops (admin MFA) ----

export async function listFakaBridgeTasks(query: {
  status?: string
  revokeStatus?: string
  page?: number
  pageSize?: number
}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.FakaBridgeTaskWhereInput = {}
  if (query.status) where.status = query.status
  if (query.revokeStatus) where.revokeStatus = query.revokeStatus

  const [total, items] = await Promise.all([
    prisma.fakaBridgeTask.count({ where }),
    prisma.fakaBridgeTask.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        order: {
          select: {
            id: true,
            status: true,
            price: true,
            productNameSnapshot: true,
            user: { select: { id: true, email: true } },
          },
        },
      },
    }),
  ])

  return {
    items: items.map(t => ({
      id: t.id,
      orderId: t.orderId,
      status: t.status,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      lastError: t.lastError,
      xboardTradeNo: t.xboardTradeNo,
      requestOrderNo: t.requestOrderNo,
      emailSnapshot: t.emailSnapshot,
      skuSnapshot: t.skuSnapshot,
      periodSnapshot: t.periodSnapshot,
      revokeStatus: t.revokeStatus,
      revokeAttempts: t.revokeAttempts,
      revokedAt: t.revokedAt,
      lastRevokeError: t.lastRevokeError,
      reconcileNote: t.reconcileNote,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      nextAttemptAt: t.nextAttemptAt,
      order: t.order,
    })),
    total,
    page,
    pageSize,
  }
}

export async function getFakaBridgeTaskStats() {
  const byStatus = await prisma.fakaBridgeTask.groupBy({
    by: ['status'],
    _count: { _all: true },
  })
  const byRevoke = await prisma.fakaBridgeTask.groupBy({
    by: ['revokeStatus'],
    _count: { _all: true },
  })
  return {
    byStatus: Object.fromEntries(byStatus.map(g => [g.status, g._count._all])),
    byRevoke: Object.fromEntries(
      byRevoke.map(g => [g.revokeStatus ?? 'null', g._count._all])
    ),
    configured: isFakaBridgeConfigured(),
  }
}

/** Admin: re-queue a failed/cancelled provision for another attempt. */
export async function retryFakaBridgeTask(adminUserId: number, taskId: number) {
  const task = await prisma.fakaBridgeTask.findUnique({
    where: { id: taskId },
    include: { order: { select: { id: true, status: true } } },
  })
  if (!task) throw notFound('FakaBridge 任务不存在')
  // Already opened: re-sync DeliveryRecord.expiresAt from Xboard (display drift repair).
  if (task.status === 'succeeded' && task.order.status === 'delivered') {
    let sync: Awaited<ReturnType<typeof syncFakaExpiresAtFromRemote>>
    try {
      sync = await syncFakaExpiresAtFromRemote(taskId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw badRequest(msg.includes('not configured') ? 'FakaBridge 未配置' : msg)
    }
    await prisma.adminLog.create({
      data: {
        adminUserId,
        action: '同步Faka订阅到期',
        targetType: 'faka_bridge_task',
        targetId: taskId,
        detail: `orderId=${task.orderId}; aligned=${sync.aligned}; ${sync.previousExpiresAt ?? 'null'} → ${sync.expiresAt ?? 'null'}; ${sync.message}`,
      },
    })
    return {
      id: taskId,
      status: task.status,
      outcome: sync.aligned ? 'expires_aligned' : 'expires_unchanged',
      ...sync,
    }
  }
  if (task.order.status === 'refunded' || task.order.status === 'closed') {
    throw badRequest('订单已退款/关闭，请走撤销而非重试开通')
  }

  if (!(await isLeaseExpiredUtc(prisma, taskId))) {
    throw badRequest('任务正在处理中（租约未过期），请稍后再重试')
  }
  if (task.cancelRequested) {
    throw badRequest('任务已标记取消/退款，请走撤销而非重试开通')
  }

  await prisma.fakaBridgeTask.update({
    where: { id: taskId },
    data: {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      // Do not clear an active lease (already gated above).
      lastError: null,
      completedAt: null,
      cancelRequested: false,
      reconcileNote: `admin retry by user ${adminUserId}`,
    },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '重试Faka开通',
      targetType: 'faka_bridge_task',
      targetId: taskId,
      detail: `orderId=${task.orderId}`,
    },
  })

  // Fire immediately (outside test skip inside schedule helper — call worker)
  if (config.nodeEnv !== 'test') {
    setImmediate(() => {
      void processFakaBridgeTask(taskId).catch(() => undefined)
    })
  }

  return { ok: true, taskId, status: 'pending' }
}

/** Admin: force queue / re-run Xboard revoke for a succeeded provision. */
export async function forceFakaBridgeRevoke(adminUserId: number, taskId: number) {
  const task = await prisma.fakaBridgeTask.findUnique({ where: { id: taskId } })
  if (!task) throw notFound('FakaBridge 任务不存在')
  const allowed =
    task.status === 'succeeded' ||
    task.status === 'needs_reconcile' ||
    (task.status === 'failed' && Boolean(task.xboardTradeNo)) ||
    task.cancelRequested
  if (!allowed) {
    throw badRequest('仅已开通/可能已开通的任务可强制撤销（succeeded / needs_reconcile / failed+trade_no）')
  }
  if (task.revokeStatus === 'succeeded') {
    throw badRequest('任务已撤销成功')
  }
  if (!(await isLeaseExpiredUtc(prisma, taskId))) {
    throw badRequest('任务租约未过期，请稍后再强制撤销')
  }

  await prisma.fakaBridgeTask.update({
    where: { id: taskId },
    data: {
      revokeStatus: 'pending',
      lastRevokeError: null,
      // Override any provision/revoke cooldown: this endpoint is explicitly a force retry.
      nextAttemptAt: new Date(),
      cancelRequested: true,
      reconcileNote: `admin force revoke by user ${adminUserId}`,
    },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '强制撤销Xboard订阅',
      targetType: 'faka_bridge_task',
      targetId: taskId,
      detail: `orderId=${task.orderId}; requestOrderNo=${task.requestOrderNo}`,
    },
  })

  const outcome = await processFakaRevokeTask(taskId)
  return { ok: true, taskId, outcome }
}
