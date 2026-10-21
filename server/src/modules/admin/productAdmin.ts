import { assertOriginalPrice } from '../catalog/offerPolicy.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { createDefaultOffer, getDefaultOffer, syncProductProjection } from '../../lib/offers.js'
import {
  fetchFakaCapacityForSku,
  getFakaCapacityForPublicRead,
  isFakaBridgeConfigured,
  normalizeFakaOfferIntegration,
  assertOfferProvisionMutex,
} from '../../lib/fakaBridge/index.js'
import {
  assertProductDeliveryConfiguration,
  normalizeProductImageFields,
} from '../../lib/productCommercial.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { resolveProductCategory } from '../catalog/resolver.js'
import { checkProductReadiness } from '../catalog/publicationReadiness.js'
import { sanitizeCatalogRichContent } from '../catalog/contentSanitizer.js'
import { archiveAdminProduct, archivedWhere } from './productLifecycle.js'
import {
  publishProduct as publishCatalogProduct,
  unpublishProduct as unpublishCatalogProduct,
} from '../catalog/productPublication.js'
import { type CreateProductInput, type ListAdminProductsQuery, type UpdateProductInput } from './schema.js'

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

export async function createProduct(adminUserId: number, data: CreateProductInput) {
  assertOriginalPrice(data.price, data.originalPrice)
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

    assertOriginalPrice(
      data.price ?? product.price,
      data.originalPrice === undefined ? product.originalPrice : data.originalPrice
    )

    const normalizedProductData = normalizeProductImageFields(data, product.images)
    if ('richDescription' in normalizedProductData && typeof normalizedProductData.richDescription === 'string') {
      normalizedProductData.richDescription = sanitizeCatalogRichContent(normalizedProductData.richDescription) ?? ''
    }
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
      categoryId: incomingCategoryId,
      ...productUpdateFields
    } = normalizedProductData as typeof normalizedProductData & {
      categoryId?: number
    }

    const categoryPatch = incomingCategoryId != null
      ? await resolveProductCategory({ categoryId: incomingCategoryId }, tx)
      : null

    const defaultOfferForFaka = await getDefaultOffer(tx, id)
    // SKU rebind is a separate dangerous op; ordinary PUT cannot change it.
    const fakaUpdate = defaultOfferForFaka.externalIntegration != null
      ? normalizeFakaOfferIntegration(
          {
            externalIntegration: defaultOfferForFaka.externalIntegration,
            externalSku: defaultOfferForFaka.externalSku,
            deliveryMode,
          },
          { requireConfigured: defaultOfferForFaka.externalIntegration === 'faka_bridge' },
        )
      : null

    const next = await tx.product.update({
      where: { id },
      data: {
        ...productUpdateFields,
        deliveryMode,
        stockMode,
        ...(categoryPatch
          ? { categoryId: categoryPatch.categoryId, type: categoryPatch.type }
          : {}),
        ...(deliveryMode === 'instant_inventory' && product.deliveryMode !== 'instant_inventory'
          ? { stock: 0 }
          : {}),
        contentVersion: { increment: 1 },
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

export async function listAdminProducts(
  query: ListAdminProductsQuery = { page: 1, pageSize: 20, archived: 'exclude' },
) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const archived = query.archived ?? 'exclude'
  const status = query.status
  const q = query.q?.trim()

  const conditions: Prisma.ProductWhereInput[] = []
  const arc = archivedWhere(archived)
  if (Object.keys(arc).length > 0) {
    conditions.push(arc)
  }
  if (status) {
    conditions.push({ status })
  }
  if (q) {
    const isNumeric = /^\d+$/.test(q)
    if (isNumeric) {
      const idNum = Number(q)
      if (Number.isSafeInteger(idNum) && idNum > 0) {
        conditions.push({
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { id: idNum },
          ],
        })
      } else {
        conditions.push({ name: { contains: q, mode: 'insensitive' } })
      }
    } else {
      conditions.push({ name: { contains: q, mode: 'insensitive' } })
    }
  }

  const where: Prisma.ProductWhereInput = conditions.length > 0 ? { AND: conditions } : {}

  const [total, products] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
            originalPrice: true,
            validityDays: true,
            sortOrder: true,
          },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    }),
  ])

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

  const items = products.map(p => {
    const offers = p.offers.map(o => {
      const sku = o.externalSku?.toLowerCase() ?? null
      const fakaCapacity =
        o.externalIntegration === 'faka_bridge' && sku ? capBySku.get(sku) ?? null : null
      return { ...o, fakaCapacity }
    })
    const primaryFaka = offers.find(o => o.fakaCapacity?.source === 'xboard')?.fakaCapacity ?? null
    // D-MERCH-01：显式剥离遗留 Product.isHot 与 fixedContent，其余管理字段原样保留。
    const { isHot: _legacyIsHot, fixedContent: _fixedContent, ...productDto } = p
    return {
      ...productDto,
      offers,
      fakaBridge: offers.some(o => o.externalIntegration === 'faka_bridge'),
      fakaCapacity: primaryFaka,
    }
  })

  return {
    items,
    total,
    page,
    pageSize,
  }
}

/**
 * Compatibility delete: always archives. Permanent delete is DELETE .../purge.
 */
export async function deleteAdminProduct(adminUserId: number, productId: number) {
  return archiveAdminProduct(adminUserId, productId, { reason: '兼容删除入口' })
}
