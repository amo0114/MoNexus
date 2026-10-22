import { assertOriginalPrice } from '../catalog/offerPolicy.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { lockProductRow } from '../catalog/productLock.js'
import {
  guestReviewInclude,
  guestReviewState,
  invalidateGuestEligibilityIfNeeded,
} from '../catalog/guestEligibility.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import {
  assertProductDeliveryConfiguration,
  normalizeProductImageFields,
} from '../../lib/productCommercial.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { resolveProductCategory } from '../catalog/resolver.js'
import { checkProductReadiness } from '../catalog/publicationReadiness.js'
import {
  publishProduct as publishCatalogProduct,
  unpublishProduct as unpublishCatalogProduct,
} from '../catalog/productPublication.js'
import type { PurchaseFormField } from '../../lib/purchaseForm.js'
import { createDefaultOffer, getDefaultOffer, syncProductProjection } from '../../lib/offers.js'

import { resolvePagination } from '../../lib/pagination.js'
import { withCheckoutVersion } from './offerSerialization.js'
import { insertOffer, type OfferWriteInput } from './offerService.js'

// ---- Products ----

const productListInclude = {
  ...guestReviewInclude,
  _count: { select: { inventory: { where: { status: 'available' } } } },
  offers: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { inventory: { where: { status: 'available' } } } } },
  },
} satisfies Prisma.ProductInclude

type ProductWithAvailableStock = Prisma.ProductGetPayload<{ include: typeof productListInclude }>

export interface MerchantProductListFilters {
  page?: number
  pageSize?: number
  status?: string
  q?: string
  type?: string
  deliveryMode?: string
  lowStock?: boolean
}

function buildProductWhere(merchantId: number, filters: MerchantProductListFilters): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = { merchantId }

  if (filters.status) where.status = filters.status
  if (filters.type) where.type = filters.type
  if (filters.deliveryMode) where.deliveryMode = filters.deliveryMode
  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: Prisma.QueryMode.insensitive } },
      { description: { contains: filters.q, mode: Prisma.QueryMode.insensitive } },
      { type: { contains: filters.q, mode: Prisma.QueryMode.insensitive } },
    ]
  }

  return where
}

function isLowStockProduct(product: ProductWithAvailableStock, threshold: number) {
  if (product.stockMode !== 'limited') return false
  if (product.deliveryMode === 'instant_inventory') return product._count.inventory <= threshold
  if (product.deliveryMode === 'instant_fixed') return product.stock <= threshold
  return false // manual_service 不参与低库存提醒
}

function serializeMerchantProduct(product: ProductWithAvailableStock, lowStockThreshold: number) {
  const availableStock = product._count.inventory
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    richDescription: product.richDescription,
    type: product.type,
    icon: product.icon,
    imageUrl: product.imageUrl,
    images: product.images,
    price: product.price,
    originalPrice: product.originalPrice,
    // 即时库存以 InventoryItem.status=available 为唯一运行时来源；
    // Product.stock 仅供固定内容/人工服务的限量额度使用。
    stock: product.deliveryMode === 'instant_inventory' ? availableStock : product.stock,
    availableStock,
    sales: product.sales,
    status: product.status,
    visibility: product.visibility,
    // SPEC-CATALOG-VIS-001 §4.6：商家只看结论（固定文案由前端映射），不暴露审批版本。
    guestReview: guestReviewState({
      visibility: product.visibility,
      publicContentRevision: product.publicContentRevision,
      categoryGuestVisibility: product.category?.guestVisibility,
      eligibility: product.guestEligibility,
    }),
    deliveryMode: product.deliveryMode,
    stockMode: product.stockMode,
    fixedContent: product.fixedContent,
    fixedContentType: product.fixedContentType,
    purchaseForm: product.purchaseForm ?? [],
    // P4a：商家端返回完整 Offer 列表（含 fixedContent——商家本就可见自己商品
    // 的交付配置）；公开接口走 serializePublicOffer 剥离。
    offers: product.offers.map(({ _count, ...offer }) => withCheckoutVersion(offer, {
      // Offer-first 工作台必须在背景刷新后仍看到正确的目标 Offer 库存。
      // instant_inventory 不使用原始 Offer.stock；其他模式保持数值名额。
      stock: offer.deliveryMode === 'instant_inventory' ? _count.inventory : offer.stock,
      availableStock: offer.deliveryMode === 'instant_inventory' ? _count.inventory : undefined,
    })),
    merchantId: product.merchantId,
    createdAt: product.createdAt,
    lowStock: isLowStockProduct(product, lowStockThreshold),
  }
}

/**
 * D-MERCH-01：Product.isHot 是遗留只读列，不进入任何商家/管理端 wire DTO。
 * 公开投影的 isHot 由 merchandising run 计算（与 Product.isHot 列无关）。
 * 仅用于剥离 create/update 直接返回的 Prisma Product 行，不改变持久化。
 */
function stripLegacyIsHot<T extends { isHot: boolean }>(product: T): Omit<T, 'isHot'> {
  const { isHot: _legacyIsHot, ...rest } = product
  return rest
}

export async function listMyProducts(merchantId: number, filters: MerchantProductListFilters = {}) {
  const { page, pageSize } = await resolvePagination(filters.page, filters.pageSize)
  const lowStockThreshold = await getSystemConfigValue('lowStockThreshold')
  const where = buildProductWhere(merchantId, filters)
  const orderBy = { createdAt: 'desc' } as const

  if (typeof filters.lowStock === 'boolean') {
    const products = await prisma.product.findMany({
      where,
      include: productListInclude,
      orderBy,
    })
    const filtered = products
      .filter(product => isLowStockProduct(product, lowStockThreshold) === filters.lowStock)
      .map(product => serializeMerchantProduct(product, lowStockThreshold))

    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
    }
  }

  const [total, products] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: productListInclude,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return {
    items: products.map(product => serializeMerchantProduct(product, lowStockThreshold)),
    total,
    page,
    pageSize,
  }
}

export async function createMyProduct(
  merchantId: number,
  data: {
    name: string; description?: string; richDescription?: string;
    // B_CAT (SPEC-CATALOG-OPS-001 §7.4): legacy `type` is a compatibility input;
    // new writes should use `categoryId` (exactly one required, schema-enforced).
    type?: string; categoryId?: number; icon?: string; imageUrl?: string | null; images?: string[];
    price: number; originalPrice?: number; deliveryMode?: string;
    stockMode?: string; fixedContent?: string; fixedContentType?: string;
    purchaseForm?: PurchaseFormField[];
    // P4a F3：向导原子发布——默认规格名 + 额外规格与商品同事务落库。
    primaryOfferName?: string;
    // 复审 P2-2：默认规格的订阅有效期（落 Offer，不进 Product 列）。
    validityDays?: number | null;
    offers?: (OfferWriteInput & { name: string; price: number })[]
  }
) {
  assertOriginalPrice(data.price, data.originalPrice)
  // primaryOfferName/validityDays/offers 只进 Offer 表，不进 Product 列。
  // B_CAT：categoryId/type 交由 resolver 在事务内解析（schema 已保证二者只给其一）。
  const {
    categoryId: _categoryId, type: _type,
    primaryOfferName: _primaryOfferName, validityDays: _validityDays, offers: _offers,
    ...productFields
  } = data
  const normalizedProductData = normalizeProductImageFields(productFields)
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

  const product = await prisma.$transaction(async tx => {
    // B_CAT：用事务内 client 解析 categoryId/type（不开启嵌套事务）。
    const { categoryId, type } = await resolveProductCategory(
      { categoryId: data.categoryId, type: data.type },
      tx,
    )
    const created = await tx.product.create({
      data: {
        ...normalizedProductData,
        categoryId,
        type,
        deliveryMode,
        stockMode,
        fixedContentType,
        stock: 0,
        status: 'draft',
        merchantId,
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
      validityDays: data.validityDays ?? null,
    }, data.primaryOfferName)
    // F3：额外规格同事务创建，任一条校验失败 → 整体回滚（无孤儿商品）。
    for (const offerInput of data.offers ?? []) {
      await insertOffer(tx, merchantId, created.id, offerInput)
    }
    if (data.offers?.length) {
      await syncProductProjection(tx, created.id)
      // 投影（最低价/库存合计）可能已被额外规格改写，返回同步后的行。
      return tx.product.findUniqueOrThrow({ where: { id: created.id } })
    }
    return created
  })

  await invalidateProductPublicCache(product.id, { list: true })
  // 返回边界最小剥离：wire DTO 不携带遗留 Product.isHot（D-MERCH-01）。
  return stripLegacyIsHot(product)
}

async function assertProductOwnedByMerchant(merchantId: number, productId: number): Promise<void> {
  const owned = await prisma.product.findFirst({
    where: { id: productId, merchantId },
    select: { id: true },
  })
  if (!owned) throw notFound('商品不存在')
}

export async function getMyProductReadiness(merchantId: number, productId: number) {
  await assertProductOwnedByMerchant(merchantId, productId)
  return checkProductReadiness(productId)
}

export async function publishMyProduct(merchantId: number, productId: number) {
  await assertProductOwnedByMerchant(merchantId, productId)
  return publishCatalogProduct(productId)
}

export async function unpublishMyProduct(merchantId: number, productId: number) {
  await assertProductOwnedByMerchant(merchantId, productId)
  return unpublishCatalogProduct(productId)
}

export async function updateMyProduct(merchantId: number, productId: number, data: Record<string, unknown>) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId } })
  if (!product) throw notFound('商品不存在')

  // Category writes are authoritative by id (legacy type is still accepted
  // for compatibility). Resolve once up front so the persisted label snapshot
  // cannot drift from the referenced category.
  const hasCategoryInput = Object.prototype.hasOwnProperty.call(data, 'categoryId')
    || Object.prototype.hasOwnProperty.call(data, 'type')
  const resolvedCategory = hasCategoryInput
    ? await resolveProductCategory({
        categoryId: typeof data.categoryId === 'number' ? data.categoryId : undefined,
        type: typeof data.type === 'string' ? data.type : undefined,
      })
    : null

  const nextPrice = typeof data.price === 'number' ? data.price : product.price
  const nextOriginalPrice = 'originalPrice' in data
    ? data.originalPrice as number | null
    : product.originalPrice
  assertOriginalPrice(nextPrice, nextOriginalPrice)
  const normalizedProductDataWithCategory = normalizeProductImageFields(
    data as Record<string, unknown> & { imageUrl?: string | null; images?: string[] },
    product.images
  )
  const { categoryId: _categoryId, type: _type, ...normalizedProductData } =
    normalizedProductDataWithCategory as Record<string, unknown>

  const deliveryMode = (normalizedProductData.deliveryMode as string | undefined) ?? product.deliveryMode
  if (deliveryMode !== product.deliveryMode) {
    const [inventoryCount, orderCount] = await prisma.$transaction([
      prisma.inventoryItem.count({ where: { productId } }),
      prisma.order.count({ where: { productId } }),
    ])
    if (inventoryCount > 0 || orderCount > 0) {
      throw badRequest('商品已有库存记录或订单，不能修改履约模式')
    }
  }
  const stockMode = (normalizedProductData.stockMode as string | undefined)
    ?? (normalizedProductData.deliveryMode && deliveryMode !== product.deliveryMode
      ? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
      : product.stockMode)
  const incomingStock = typeof normalizedProductData.stock === 'number' ? normalizedProductData.stock : undefined

  // 商家切换交付模式但未显式清空旧 fixedContent 时给出引导性报错，避免「仅固定内容交付支持 fixedContent」造成困惑
  if (!('fixedContent' in normalizedProductData) && product.fixedContent != null && deliveryMode !== 'instant_fixed') {
    throw badRequest('切换交付模式请同时将 fixedContent 置空（传 null）')
  }

  // P5：file 形态的交付配置只能走规格管理——商品级 API 面上没有 fixedFileId，
  // 商品级改交付模式/固定内容会把默认规格推向违反 file 不变量的状态。
  // 名称/价格/图片/名额等其余编辑不受影响。
  const isFileFormProjection = product.fixedContentType === 'file'
  if (isFileFormProjection && (
    normalizedProductData.deliveryMode != null
    || 'fixedContent' in normalizedProductData
    || normalizedProductData.fixedContentType != null
  )) {
    throw badRequest('文件交付规格的交付配置请在「规格管理」中修改')
  }
  const fileFormDefaultOffer = isFileFormProjection ? await getDefaultOffer(prisma, productId) : null

  assertProductDeliveryConfiguration({
    deliveryMode,
    stockMode,
    incomingStock,
    effectiveStock: incomingStock ?? product.stock,
    fixedContent: 'fixedContent' in normalizedProductData
      ? (normalizedProductData.fixedContent as string | null)
      : product.fixedContent,
    fixedContentType: (normalizedProductData.fixedContentType as string | undefined) ?? product.fixedContentType,
    fixedFileId: fileFormDefaultOffer?.fixedFileId ?? null,
    allowFileForm: isFileFormProjection,
  })

  // P4a：商品级编辑作用于默认 Offer（真相源），Product 商业列由投影同步对齐。
  // 多 SKU 商品的其余规格不受商品级编辑影响，仅能通过 Offer 接口修改。
  const switchedToInstantInventory =
    deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
  const updated = await prisma.$transaction(async tx => {
    // SPEC-CATALOG-VIS-001 §4.5（P1.5-A）：展示写入与准入失效必须共用商品行锁，
    // 否则两个并发编辑可能各自基于不同版本递增 revision，导致批准失效错乱。
    await lockProductRow(tx, productId)
    // SPEC-CATALOG-VIS-001 §4.4（P1.5-A 复审）：**必须在写入前判定**是否
    // 触及展示内容——写入后读到的已是新值，比较必然判为"未变"。
    const productWriteData: Record<string, unknown> = {
      ...normalizedProductData,
      ...(resolvedCategory
        ? { categoryId: resolvedCategory.categoryId, type: resolvedCategory.type }
        : {}),
    }
    const invalidation = await invalidateGuestEligibilityIfNeeded(tx, productId, productWriteData)

    await tx.product.update({
      where: { id: productId },
      data: {
        ...normalizedProductData,
        ...(resolvedCategory
          ? { categoryId: resolvedCategory.categoryId, type: resolvedCategory.type }
          : {}),
        deliveryMode,
        stockMode,
        // 新建/无业务记录商品切到即时库存时，遗留的额度字段不再代表库存。
        ...(switchedToInstantInventory ? { stock: 0 } : {}),
        contentVersion: { increment: 1 },
      },
    })
    const defaultOffer = await getDefaultOffer(tx, productId)
    await tx.offer.update({
      where: { id: defaultOffer.id },
      data: {
        ...(typeof data.price === 'number' ? { price: data.price } : {}),
        ...('originalPrice' in data ? { originalPrice: data.originalPrice as number | null } : {}),
        deliveryMode,
        stockMode,
        ...('fixedContent' in normalizedProductData
          ? { fixedContent: normalizedProductData.fixedContent as string | null }
          : {}),
        ...(normalizedProductData.fixedContentType != null
          ? { fixedContentType: normalizedProductData.fixedContentType as string }
          : {}),
        ...(incomingStock !== undefined ? { stock: incomingStock } : {}),
        ...(switchedToInstantInventory ? { stock: 0 } : {}),
      },
    })
    await syncProductProjection(tx, productId)
    const row = await tx.product.findUniqueOrThrow({ where: { id: productId } })
    return { row, guestEligibilityInvalidated: invalidation !== null }
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  // 返回边界最小剥离：wire DTO 不携带遗留 Product.isHot（D-MERCH-01）。
  return {
    ...stripLegacyIsHot(updated.row),
    guestEligibilityInvalidated: updated.guestEligibilityInvalidated,
  }
}
