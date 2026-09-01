import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { wrapCache } from '../../lib/cache.js'
import { badRequest, HttpError, notFound } from '../../lib/httpError.js'
import { serializePublicOffer } from '../../lib/offers.js'
import {
  getFakaCapacityForPublicRead,
  getCachedFakaCapacityByPlanId,
  type FakaCapacitySnapshot,
} from '../../lib/fakaBridge/index.js'
import {
  buildProductDetailCacheKey,
  buildProductListCacheKey,
} from './cache.js'
import {
  assertCursorFilterMatches,
  computeFilterHash,
  decodeOrganicCursor,
  decorateProducts,
  encodeOrganicCursor,
  resolveCursorForRequest,
  type OrganicCursorPayload,
  type ProjectionRun,
} from '../merchandising/publicProjection.js'

interface ProductListParams {
  query?: string
  categoryCode?: string
  category?: string
  cursor?: string
  page?: number
  pageSize?: number
}

const productListSelect = {
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
  status: true,
  deliveryMode: true,
  stockMode: true,
  ratingAvg: true,
  ratingCount: true,
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true } },
  category: { select: { id: true, code: true, label: true } },
  // P4a：公开可售状态从 active 规格集合推导，不再信任 Product 投影——
  // stockMode 投影取自默认规格（可能已下架），混合规格商品会误报售罄/不限。
  // Faka：列表页也要 external* 以投影 Xboard 剩余名额。
  offers: {
    where: { status: 'active' },
    select: {
      id: true,
      deliveryMode: true,
      stockMode: true,
      stock: true,
      externalIntegration: true,
      externalSku: true,
    },
  },
} satisfies Prisma.ProductSelect

const productDetailSelect = {
  id: true,
  name: true,
  description: true,
  richDescription: true,
  type: true,
  icon: true,
  imageUrl: true,
  images: true,
  price: true,
  originalPrice: true,
  stock: true,
  sales: true,
  status: true,
  archivedAt: true,
  deliveryMode: true,
  stockMode: true,
  // 购买前表单定义：买家需在详情/结算时看到并填写，属公开数据（答案才是敏感的）。
  purchaseForm: true,
  ratingAvg: true,
  ratingCount: true,
  // P4a：公开 SKU 列表（仅 active）；序列化经 serializePublicOffer 剥离 fixedContent。
  // P5：file 形态附带文件大小（「文件交付 · 约 X MB」展示用），仅 size 一个数字。
  offers: {
    where: { status: 'active' },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { fixedFile: { select: { size: true } } },
  },
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true } },
  category: { select: { id: true, code: true, label: true } },
} satisfies Prisma.ProductSelect

type ProductListItem = Prisma.ProductGetPayload<{ select: typeof productListSelect }>
type ProductDetail = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>

type AvailabilityOffer = { id: number; deliveryMode: string; stockMode: string; stock: number }

/**
 * 公开可售状态（stock/stockMode 契约字段）从 active 规格集合推导：
 * - 任一 active 规格不限量 → 商品不限量（列表/详情永不显示售罄）
 * - 否则 stock = 各 active 规格可售量之和（即时库存规格用真实可用条目数，
 *   Offer.stock 在该模式下是无人维护的陈旧值）
 * 前端的售罄判断（stockMode !== 'unlimited' && stock === 0）契约不变。
 * offers 为空（迁移前数据兜底）时退回投影语义。
 */
function computePublicAvailability(
  product: { deliveryMode: string; stockMode: string; stock: number; _count: { inventory: number } },
  offers: AvailabilityOffer[],
  offerAvailableCounts: Map<number, number>
): { stock: number; stockMode: string } {
  if (offers.length === 0) {
    return {
      stock: product.deliveryMode === 'instant_inventory' ? product._count.inventory : product.stock,
      stockMode: product.stockMode,
    }
  }
  if (offers.some(offer => offer.stockMode === 'unlimited')) {
    return { stock: product.stock, stockMode: 'unlimited' }
  }
  const stock = offers.reduce(
    (sum, offer) =>
      sum +
      (offer.deliveryMode === 'instant_inventory'
        ? offerAvailableCounts.get(offer.id) ?? 0
        : offer.stock),
    0
  )
  return { stock, stockMode: 'limited' }
}

/** 批量取即时库存规格的真实可用条目数（一次 groupBy 服务整页/单品）。 */
async function countAvailableByOffer(offers: AvailabilityOffer[]): Promise<Map<number, number>> {
  const instantOfferIds = offers
    .filter(offer => offer.deliveryMode === 'instant_inventory')
    .map(offer => offer.id)
  const counts = new Map<number, number>()
  if (instantOfferIds.length === 0) return counts
  const grouped = await prisma.inventoryItem.groupBy({
    by: ['offerId'],
    where: { offerId: { in: instantOfferIds }, status: 'available' },
    _count: { _all: true },
  })
  for (const row of grouped) counts.set(row.offerId, row._count._all)
  return counts
}

function serializePublicProductListItem(
  product: ProductListItem,
  offerAvailableCounts: Map<number, number>,
  fakaBySku: Map<string, FakaCapacitySnapshot> = new Map()
) {
  const { _count, offers, ...publicProduct } = product
  const localAvailability = computePublicAvailability(product, offers, offerAvailableCounts)

  const fakaCaps: FakaCapacitySnapshot[] = []
  for (const offer of offers) {
    const integration = (offer as { externalIntegration?: string | null }).externalIntegration
    const sku = (offer as { externalSku?: string | null }).externalSku
    if (integration === 'faka_bridge' && sku) {
      const cap = fakaBySku.get(sku.trim().toLowerCase())
      if (cap) fakaCaps.push(cap)
    }
  }
  const fakaAvailability = projectFakaAvailability(fakaCaps)
  // 商品级容量摘要：多周期共用同一 plan 名额，取代表快照（非 null 以便卡片显示「剩余名额」）。
  const fakaCapacityRaw = pickProductFakaCapacity(fakaCaps)
  const fakaCapacity = fakaCapacityRaw ? toPublicFakaCapacity(fakaCapacityRaw) : null

  return {
    ...publicProduct,
    // 可售状态：Faka 用 Xboard 名额，否则本地规格推导。列表不携带 offers 数组。
    ...(fakaAvailability ?? localAvailability),
    fakaCapacity,
    ratingAvg: Number(product.ratingAvg),
  }
}

/**
 * Storefront reads must never await Xboard.  This projects a fresh/stale
 * in-process snapshot or an unavailable fallback, while the capacity module
 * coalesces background refreshes.  plan-{id}-* aliases share one primary
 * refresh per page; named SKUs cannot safely infer shared plan membership.
 */
function loadFakaCapacityBySku(
  offers: Array<{ externalIntegration?: string | null; externalSku?: string | null }>
): Map<string, FakaCapacitySnapshot> {
  const skus = [
    ...new Set(
      offers
        .filter(o => o.externalIntegration === 'faka_bridge' && o.externalSku)
        .map(o => String(o.externalSku).trim().toLowerCase())
    ),
  ]
  const map = new Map<string, FakaCapacitySnapshot>()
  if (skus.length === 0) return map

  const primary: string[] = []
  const deferredPlanSkus: Array<{ sku: string; planId: number }> = []
  const primarySkuByPlanId = new Map<number, string>()
  const seenPlanIds = new Set<number>()
  for (const sku of skus) {
    const m = sku.match(/^plan-(\d+)-/)
    if (m) {
      const planId = Number(m[1])
      if (seenPlanIds.has(planId)) {
        deferredPlanSkus.push({ sku, planId })
        continue
      }
      seenPlanIds.add(planId)
      primarySkuByPlanId.set(planId, sku)
    }
    primary.push(sku)
  }

  for (const sku of primary) {
    map.set(sku, getFakaCapacityForPublicRead(sku))
  }

  // Fill plan-* siblings from a warm plan cache or the primary's public
  // projection.  Either route schedules at most one background probe.
  for (const { sku, planId } of deferredPlanSkus) {
    const cached = getCachedFakaCapacityByPlanId(planId)
    if (cached) {
      map.set(sku, { ...cached, sku })
    } else {
      const primarySku = primarySkuByPlanId.get(planId)
      const primaryCapacity = primarySku ? map.get(primarySku) : null
      if (primaryCapacity) {
        map.set(sku, { ...primaryCapacity, sku })
      } else {
        map.set(sku, getFakaCapacityForPublicRead(sku))
      }
    }
  }

  return map
}

/**
 * Xboard capacity_limit 按 plan 共享：月付/季付/…/流量包/重置包是同一 plan 的不同周期，
 * remaining 相同，绝不能按规格数累加（否则 2 名额 × 8 周期 = 库存 16）。
 * 多 plan 商品（极少见）再对「去重后的 plan」求和。
 */
function dedupeFakaCapsByPlan(caps: FakaCapacitySnapshot[]): FakaCapacitySnapshot[] {
  const byKey = new Map<string, FakaCapacitySnapshot>()
  for (const c of caps) {
    if (c.source !== 'xboard') continue
    const key = c.planId != null ? `plan:${c.planId}` : `sku:${c.sku}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, c)
      continue
    }
    // 同 plan 多 SKU：保留剩余更少的（更保守）；任一为不限则视为不限
    if (prev.remaining === null || c.remaining === null) {
      byKey.set(key, prev.remaining === null ? prev : c)
      continue
    }
    if ((c.remaining ?? 0) < (prev.remaining ?? 0)) byKey.set(key, c)
  }
  return [...byKey.values()]
}

function projectFakaAvailability(
  caps: FakaCapacitySnapshot[]
): { stock: number; stockMode: string } | null {
  if (caps.length === 0) return null
  const unique = dedupeFakaCapsByPlan(caps)
  if (unique.length === 0) return null
  // Any unlimited Xboard plan → product shows 不限 (when sellable path works).
  if (unique.some(c => c.remaining === null)) {
    return { stock: 0, stockMode: 'unlimited' }
  }
  const known = unique.filter(c => c.remaining != null)
  if (known.length === 0) return null
  const stock = known.reduce((sum, c) => sum + (c.remaining ?? 0), 0)
  return { stock, stockMode: 'limited' }
}


/** Public product payload must not leak internal SKU / plan / activeUsers. */
function toPublicFakaCapacity(cap: FakaCapacitySnapshot) {
  return {
    remaining: cap.remaining,
    capacityLimit: cap.capacityLimit,
    sellable: cap.sellable,
    source: cap.source,
    reason: cap.reason,
  }
}

function isUnavailableFakaCapacity(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    (value as { source?: unknown }).source === 'unavailable'
  )
}

/** 列表/详情商品级 fakaCapacity：单 SKU 直接用；多周期同 plan 取首个 xboard 快照。 */
function pickProductFakaCapacity(caps: FakaCapacitySnapshot[]): FakaCapacitySnapshot | null {
  if (caps.length === 0) return null
  if (caps.length === 1) return caps[0]
  const unique = dedupeFakaCapsByPlan(caps)
  if (unique.length === 1) return unique[0]
  // 多 plan：仍给一个可展示摘要（前端规格级会覆盖）；优先 xboard 且有限名额
  return (
    unique.find(c => c.remaining != null) ??
    unique[0] ??
    caps.find(c => c.source === 'xboard') ??
    caps[0] ??
    null
  )
}

function serializePublicProductDetail(
  product: ProductDetail,
  offerAvailableCounts: Map<number, number>,
  fakaByOfferId: Map<number, FakaCapacitySnapshot> = new Map()
) {
  const { _count, offers, archivedAt: _archivedAt, ...publicProduct } = product
  const localAvailability = computePublicAvailability(product, offers, offerAvailableCounts)
  const fakaCaps = [...fakaByOfferId.values()]
  const fakaAvailability = projectFakaAvailability(fakaCaps)

  return {
    ...publicProduct,
    // Faka 商品：用 Xboard 剩余名额投影到 stock/stockMode，详情页「库存」可见。
    // 非 Faka 或 capacity 不可达：保持本地推导。
    ...(fakaAvailability ?? localAvailability),
    // 商品级容量摘要；多周期共用 plan 时取代表快照，规格切换后由 offer.fakaCapacity 覆盖。
    fakaCapacity: (() => { const c = pickProductFakaCapacity(fakaCaps); return c ? toPublicFakaCapacity(c) : null })(),
    ratingAvg: Number(product.ratingAvg),
    // 公开 Offer 剥离 fixedContent；即时库存规格的 stock 用实际可用条目数。
    offers: offers.map(offer => {
      const serialized = serializePublicOffer(offer)
      const fakaCapacity = fakaByOfferId.get(offer.id) ?? null
      const withFaka = fakaCapacity
        ? {
            ...serialized,
            fakaCapacity: toPublicFakaCapacity(fakaCapacity),
            // 规格级库存展示：Xboard remaining（null = 不限）
            ...(fakaCapacity.source === 'xboard'
              ? fakaCapacity.remaining == null
                ? { stockMode: 'unlimited' as const, stock: 0 }
                : { stockMode: 'limited' as const, stock: fakaCapacity.remaining }
              : {}),
          }
        : serialized
      return offer.deliveryMode === 'instant_inventory' && !fakaCapacity
        ? { ...withFaka, stock: offerAvailableCounts.get(offer.id) ?? 0 }
        : withFaka
    }),
  }
}

interface NormalizedProductFilters {
  query: string | null
  categoryCode: string | null
  legacyCategory: string | null
}

interface RankedProductRow {
  id: number
  isHot: boolean
  effectiveOrderCount: number
}

interface ProductListContext {
  filters: NormalizedProductFilters
  cursor: OrganicCursorPayload | null
  run: ProjectionRun | null
}

function normalizeProductFilters(params: ProductListParams): NormalizedProductFilters {
  const query = params.query?.trim().toLowerCase().normalize('NFKC') || null
  const categoryCode = params.categoryCode?.trim().toLowerCase() || null
  const legacy = params.category?.trim()
  return {
    query,
    categoryCode,
    legacyCategory: categoryCode || !legacy || legacy === '全部' ? null : legacy,
  }
}

function productFilterHashInput(filters: NormalizedProductFilters): Record<string, unknown> {
  return {
    query: filters.query,
    categoryCode: filters.categoryCode,
    legacyCategory: filters.legacyCategory,
  }
}

async function listRankedProductRows(
  params: ProductListParams,
  context: ProductListContext,
): Promise<RankedProductRow[]> {
  const { page = 1, pageSize = 20 } = params
  const { filters, cursor, run } = context
  const where: Prisma.Sql[] = [Prisma.sql`p."status" = 'active' AND p."archivedAt" IS NULL`]

  if (filters.categoryCode) {
    where.push(Prisma.sql`c."code" = ${filters.categoryCode} AND c."status" = 'active'`)
  } else if (filters.legacyCategory) {
    where.push(Prisma.sql`c."label" = ${filters.legacyCategory} AND c."status" = 'active'`)
  }

  if (filters.query) {
    const pattern = `%${filters.query}%`
    where.push(Prisma.sql`(
      p."name" ILIKE ${pattern}
      OR COALESCE(p."description", '') ILIKE ${pattern}
      OR p."type" ILIKE ${pattern}
      OR c."label" ILIKE ${pattern}
    )`)
  }

  const snapshotJoin = run
    ? Prisma.sql`LEFT JOIN "ProductMerchandisingSnapshot" s
        ON s."productId" = p."id" AND s."runId" = ${run.id}::uuid`
    : Prisma.empty
  const hotExpression = run ? Prisma.sql`COALESCE(s."isHot", false)` : Prisma.sql`false`
  const countExpression = run
    ? Prisma.sql`COALESCE(s."effectiveOrderCount", 0)`
    : Prisma.sql`0`

  if (cursor) {
    where.push(Prisma.sql`(
      ${hotExpression}, ${countExpression}, p."id"
    ) < (
      ${cursor.isHot}, ${cursor.effectiveOrderCount}, ${cursor.productId}
    )`)
  }

  const offset = cursor ? Prisma.empty : Prisma.sql`OFFSET ${(page - 1) * pageSize}`
  return prisma.$queryRaw<RankedProductRow[]>`
    SELECT
      p."id" AS "id",
      ${hotExpression} AS "isHot",
      ${countExpression}::int AS "effectiveOrderCount"
    FROM "Product" p
    INNER JOIN "ProductCategory" c ON c."id" = p."categoryId"
    ${snapshotJoin}
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY "isHot" DESC, "effectiveOrderCount" DESC, p."id" DESC
    LIMIT ${pageSize + 1}
    ${offset}
  `
}

async function attachListMerchandising<
  T extends { items: Array<{ id: number; merchant: { id: number } | null }> },
>(result: T, run: ProjectionRun | null) {
  const decorated = await decorateProducts(
    result.items.map(item => ({ id: item.id, merchantId: item.merchant?.id ?? null })),
    run,
  )
  const projectionById = new Map(decorated.map(item => [item.id, item.merchandising]))
  return {
    ...result,
    items: result.items.map(item => ({ ...item, merchandising: projectionById.get(item.id)! })),
  }
}

export async function listProducts(params: ProductListParams = {}) {
  const filters = normalizeProductFilters(params)
  const cursor = params.cursor ? decodeOrganicCursor(params.cursor) : null
  if (cursor) assertCursorFilterMatches(cursor, productFilterHashInput(filters))
  const pinned = await resolveCursorForRequest(cursor)
  const run = pinned.mode === 'run' ? pinned.run : null
  const context: ProductListContext = { filters, cursor, run }
  const cacheKey = await buildProductListCacheKey({
    ...params,
    categoryCode: filters.categoryCode ?? undefined,
    category: filters.legacyCategory ?? undefined,
    rankingRunId: run?.id ?? null,
  })

  const load = () => listProductsFromDb(params, context)
  const baseResult = cacheKey
    ? await wrapCache('product-list', cacheKey, params.query ? 10 : params.cursor ? 20 : 30, load, {
        // A cold public read intentionally returns an unavailable projection while
        // its Xboard probe runs in the background. Do not cache that transient state.
        cachePredicate: result =>
          result.items.every(item => !isUnavailableFakaCapacity(item.fakaCapacity)),
      })
    : await load()

  // Merch identity/entitlement is decorated after the Catalog cache, so expiry,
  // revocation and editorial changes never get frozen inside a product cache entry.
  return attachListMerchandising(baseResult, run)
}

async function listProductsFromDb(params: ProductListParams, context: ProductListContext) {
  const { pageSize = 20 } = params
  const ranked = await listRankedProductRows(params, context)
  const pageRows = ranked.slice(0, pageSize)
  const products = await prisma.product.findMany({
    where: { id: { in: pageRows.map(row => row.id) }, status: 'active', archivedAt: null },
    select: productListSelect,
  })
  const productById = new Map(products.map(product => [product.id, product]))
  const items = pageRows.flatMap(row => {
    const product = productById.get(row.id)
    return product ? [product] : []
  })

  const allOffers = items.flatMap(item => item.offers)
  const offerAvailableCounts = await countAvailableByOffer(allOffers)
  const fakaBySku = loadFakaCapacityBySku(
    allOffers as Array<{ externalIntegration?: string | null; externalSku?: string | null }>,
  )
  const lastRow = pageRows.at(-1)
  const hasMore = ranked.length > pageSize
  const filterHash = computeFilterHash(productFilterHashInput(context.filters))

  return {
    items: items.map(item => serializePublicProductListItem(item, offerAvailableCounts, fakaBySku)),
    nextCursor: hasMore && lastRow
      ? encodeOrganicCursor({
          v: 1,
          runId: context.run?.id ?? null,
          isHot: lastRow.isHot,
          effectiveOrderCount: lastRow.effectiveOrderCount,
          productId: lastRow.id,
          filterHash,
        })
      : null,
    hasMore,
  }
}

export async function getProductDetail(id: number) {
  const cacheKey = await buildProductDetailCacheKey(id)
  const baseProduct = cacheKey
    ? await wrapCache('product-detail', cacheKey, 60, () => getProductDetailFromDb(id), {
        negativeTtlSec: 20,
        negativeErrorPredicate: err => err instanceof HttpError && err.status === 404,
        // Same rule as the list: Redis may cache a known capacity/stale snapshot,
        // but never the cold-cache unavailable fallback returned by SWR.
        cachePredicate: result =>
          !isUnavailableFakaCapacity(result.fakaCapacity) &&
          result.offers.every(
            offer => !('fakaCapacity' in offer) || !isUnavailableFakaCapacity(offer.fakaCapacity)
          ),
      })
    : await getProductDetailFromDb(id)

  const pinned = await resolveCursorForRequest(null)
  const run = pinned.mode === 'run' ? pinned.run : null
  const [decorated] = await decorateProducts(
    [{ id: baseProduct.id, merchantId: baseProduct.merchant?.id ?? null }],
    run,
  )
  return { ...baseProduct, merchandising: decorated.merchandising }
}

async function getProductDetailFromDb(id: number) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: productDetailSelect,
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active' || product.archivedAt) throw badRequest('商品已下架')

  const offerAvailableCounts = await countAvailableByOffer(product.offers)

  // FakaBridge：详情页只读缓存并后台刷新，绝不在请求内串行外呼 Xboard。
  const fakaByOfferId = new Map<number, FakaCapacitySnapshot>()
  for (const offer of product.offers) {
    const integration = (offer as { externalIntegration?: string | null }).externalIntegration
    const sku = (offer as { externalSku?: string | null }).externalSku
    if (integration === 'faka_bridge' && sku) {
      fakaByOfferId.set(offer.id, getFakaCapacityForPublicRead(sku))
    }
  }

  return serializePublicProductDetail(product, offerAvailableCounts, fakaByOfferId)
}
