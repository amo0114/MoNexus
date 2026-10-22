import { videoSummary } from '../productVideos/service.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { wrapCache } from '../../lib/cache.js'
import { badRequest, HttpError, notFound } from '../../lib/httpError.js'
import { projectPublicTemplateAttributes, serializePublicOffer } from '../../lib/offers.js'
import { getProductTemplate } from '../catalog/templates/registry.js'
import { emptyProductDetails } from '../catalog/templates/productDetails.js'
import { TEMPLATE_KEYS, type ProductDetails, type TemplateKey } from '../catalog/templates/types.js'
import {
  getFakaCapacityForPublicRead,
  getCachedFakaCapacityByPlanId,
  isFakaBridgeConfigured,
  type FakaCapacitySnapshot,
} from '../../lib/fakaBridge/index.js'
import {
  buildProductDetailCacheKey,
  buildProductListCacheKey,
} from './cache.js'
import {
  assertPublicProductAccess,
  guestVisibilitySql,
  isCurrentlyPubliclyVisible,
  merchantVisibleSql,
  publicVisibilityWhere,
  type ProductAudience,
} from './visibility.js'
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
import { loadPublicAssuranceByProductIds } from '../catalog/assurance/service.js'
import { queryRecommendationCandidates } from './recommendations.js'
import { signRecommendationList } from '../recommendationEvents/token.js'
import {
  aggregateOfferAvailability,
  evaluatePublicOfferAvailability,
  type AvailabilityStatus,
} from './publicAvailability.js'

interface ProductListParams {
  query?: string
  categoryCode?: string
  category?: string
  cursor?: string
  page?: number
  pageSize?: number
  audience?: import('./visibility.js').ProductAudience
  /** Internal shop scope; never accepted from the public `/api/products` query. */
  merchantId?: number
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
  archivedAt: true,
  deliveryMode: true,
  stockMode: true,
  ratingAvg: true,
  ratingCount: true,
  templateKey: true,
  templateVersion: true,
  visibility: true,
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true, status: true } },
  category: { select: { id: true, code: true, label: true, guestVisibility: true } },
  // SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入判定所需字段。必填，漏查会编译失败。
  publicContentRevision: true,
  guestEligibility: { select: { decision: true, reviewedRevision: true } },
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
      // Inputs of the public availability evaluation only; never serialized.
      fixedContentType: true,
      fixedContent: true,
      fixedFileId: true,
      fixedFile: { select: { status: true } },
      autoProvision: true,
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
  promoVideoAsset: true,
  price: true,
  originalPrice: true,
  stock: true,
  sales: true,
  status: true,
  archivedAt: true,
  visibility: true,
  templateKey: true,
  templateVersion: true,
  contentVersion: true,
  attributes: true,
  details: true,
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
    include: { fixedFile: { select: { size: true, status: true } } },
  },
  _count: { select: { inventory: { where: { status: 'available' } } } },
  merchant: { select: { id: true, name: true, status: true } },
  category: { select: { id: true, code: true, label: true, guestVisibility: true } },
  // SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入判定所需字段。必填，漏查会编译失败。
  publicContentRevision: true,
  guestEligibility: { select: { decision: true, reviewedRevision: true } },
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

type AvailabilityBatchFacts = {
  offerAvailableCounts: Map<number, number>
  webhookMerchantIds: Set<number>
  providerConfigured: boolean
}

type AvailabilityOfferInput = Parameters<typeof evaluatePublicOfferAvailability>[0] & { id: number }

/** One batch of local facts (inventory counts, webhook presence, provider config) per request. */
async function loadAvailabilityBatchFacts(
  products: Array<{
    merchant: { id: number } | null
    offers: Array<AvailabilityOffer & { autoProvision: boolean }>
  }>,
): Promise<AvailabilityBatchFacts> {
  const autoProvisionMerchantIds = [
    ...new Set(
      products
        .filter(product => product.merchant && product.offers.some(offer => offer.autoProvision))
        .map(product => product.merchant!.id),
    ),
  ]
  const [offerAvailableCounts, webhooks] = await Promise.all([
    countAvailableByOffer(products.flatMap(product => product.offers)),
    autoProvisionMerchantIds.length === 0
      ? Promise.resolve([])
      : prisma.merchantWebhookConfig.findMany({
          where: { merchantId: { in: autoProvisionMerchantIds }, status: 'active' },
          select: { merchantId: true },
        }),
  ])
  return {
    offerAvailableCounts,
    webhookMerchantIds: new Set(webhooks.map(webhook => webhook.merchantId)),
    providerConfigured: isFakaBridgeConfigured(),
  }
}

function publicOfferStatus(
  offer: AvailabilityOfferInput,
  merchantId: number | null,
  facts: AvailabilityBatchFacts,
  fakaCapacity: FakaCapacitySnapshot | null,
): AvailabilityStatus {
  return evaluatePublicOfferAvailability(offer, {
    availableInventory: facts.offerAvailableCounts.get(offer.id) ?? 0,
    hasActiveWebhook: merchantId != null && facts.webhookMerchantIds.has(merchantId),
    providerConfigured: facts.providerConfigured,
    fakaCapacity,
  })
}

function fakaSnapshotForSku(
  offer: { externalIntegration?: string | null; externalSku?: string | null },
  fakaBySku: Map<string, FakaCapacitySnapshot>,
): FakaCapacitySnapshot | null {
  if (offer.externalIntegration !== 'faka_bridge' || !offer.externalSku) return null
  return fakaBySku.get(offer.externalSku.trim().toLowerCase()) ?? null
}

function publicMerchant(merchant: { id: number; name: string; status?: string } | null | undefined) {
  if (!merchant) return null
  return { id: merchant.id, name: merchant.name }
}

/**
 * SPEC-CATALOG-VIS-001 §3.1：公开分类投影只有 id/code/label。
 *
 * 查询层为做访问判定而加载了 guestVisibility，但它是**内部字段**：
 * 输出给游客等同于告知「这个分类受限」，属于分类元数据泄露。
 * 因此这里显式白名单投影，而不是透传 Prisma 对象——新增分类字段时
 * 必须在这里显式决定是否对外，默认不对外。
 */
function publicCategory(
  category: { id: number; code: string; label: string; guestVisibility?: string | null } | null | undefined,
) {
  if (!category) return null
  return { id: category.id, code: category.code, label: category.label }
}

function resolvePublicTemplate(templateKey: string | null, templateVersion: number | null) {
  if (templateKey == null || templateVersion == null) return null
  if (!(TEMPLATE_KEYS as readonly string[]).includes(templateKey)) return null
  return getProductTemplate(templateKey as TemplateKey, templateVersion)
}

function toPublicProductDetails(value: Prisma.JsonValue | null | undefined): ProductDetails {
  const empty = emptyProductDetails()
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return empty
  const record = value as Record<string, unknown>
  const highlights = Array.isArray(record.highlights)
    ? record.highlights
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 4)
    : []
  const faq = Array.isArray(record.faq)
    ? record.faq.flatMap((item) => {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) return []
        const row = item as Record<string, unknown>
        if (typeof row.question !== 'string' || typeof row.answer !== 'string') return []
        return [{ question: row.question, answer: row.answer }]
      }).slice(0, 8)
    : []
  return {
    highlights,
    usageInstructions: typeof record.usageInstructions === 'string' ? record.usageInstructions : '',
    purchaseNotes: typeof record.purchaseNotes === 'string' ? record.purchaseNotes : '',
    afterSalesInstructions: typeof record.afterSalesInstructions === 'string' ? record.afterSalesInstructions : '',
    faq,
  }
}

function serializePublicProductListItem(
  product: ProductListItem,
  offerAvailableCounts: Map<number, number>,
  fakaBySku: Map<string, FakaCapacitySnapshot>,
  availability: AvailabilityStatus,
) {
  const { _count, offers, merchant, category, ...publicProduct } = product
  const localAvailability = computePublicAvailability(product, offers, offerAvailableCounts)

  const fakaCaps: FakaCapacitySnapshot[] = []
  for (const offer of offers) {
    const cap = fakaSnapshotForSku(offer, fakaBySku)
    if (cap) fakaCaps.push(cap)
  }
  const fakaAvailability = projectFakaAvailability(fakaCaps)
  // 商品级容量摘要：多周期共用同一 plan 名额，取代表快照（非 null 以便卡片显示「剩余名额」）。
  const fakaCapacityRaw = pickProductFakaCapacity(fakaCaps)
  const fakaCapacity = fakaCapacityRaw ? toPublicFakaCapacity(fakaCapacityRaw) : null

  return {
    ...publicProduct,
    merchant: publicMerchant(merchant),
    // SPEC-CATALOG-VIS-001 §3.1：分类 DTO 只输出公开标识三件套。
    // guestVisibility 是访问判定用的内部字段，绝不能出现在公开响应里
    // （否则等于把「这个分类受限」告诉游客）；category 在查询层仍被加载，
    // 因为判定需要它。
    category: publicCategory(category),
    // 可售状态：Faka 用 Xboard 名额，否则本地规格推导。列表不携带 offers 数组。
    ...(fakaAvailability ?? localAvailability),
    fakaCapacity,
    availability: { status: availability },
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
  fakaByOfferId: Map<number, FakaCapacitySnapshot>,
  offerStatusById: Map<number, AvailabilityStatus>,
) {
  const {
    _count,
    offers,
    promoVideoAsset,
    archivedAt: _archivedAt,
    merchant,
    category,
    attributes: rawAttributes,
    details: rawDetails,
    ...publicProduct
  } = product
  const localAvailability = computePublicAvailability(product, offers, offerAvailableCounts)
  const fakaCaps = [...fakaByOfferId.values()]
  const fakaAvailability = projectFakaAvailability(fakaCaps)
  const template = resolvePublicTemplate(product.templateKey, product.templateVersion)
  const productAttributeKeys = template?.ui.productOrder ?? []
  const offerAttributeKeys = template?.ui.offerOrder ?? []

  return {
    ...publicProduct,
    promoVideo: videoSummary(promoVideoAsset),
    merchant: publicMerchant(merchant),
    // 同列表：分类只输出公开三件套，guestVisibility 不对外。
    category: publicCategory(category),
    attributes: projectPublicTemplateAttributes(rawAttributes, productAttributeKeys),
    details: toPublicProductDetails(rawDetails),
    // Faka 商品：用 Xboard 剩余名额投影到 stock/stockMode，详情页「库存」可见。
    // 非 Faka 或 capacity 不可达：保持本地推导。
    ...(fakaAvailability ?? localAvailability),
    // 商品级容量摘要；多周期共用 plan 时取代表快照，规格切换后由 offer.fakaCapacity 覆盖。
    fakaCapacity: (() => { const c = pickProductFakaCapacity(fakaCaps); return c ? toPublicFakaCapacity(c) : null })(),
    // Product status summarizes offers; each offer keeps its own status below.
    availability: { status: aggregateOfferAvailability([...offerStatusById.values()]) },
    ratingAvg: Number(product.ratingAvg),
    // 公开 Offer 剥离 fixedContent；即时库存规格的 stock 用实际可用条目数。
    offers: offers.map(offer => {
      const serialized = {
        ...serializePublicOffer(offer, { attributeKeys: offerAttributeKeys }),
        availability: { status: offerStatusById.get(offer.id)! },
      }
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
  merchantId: number | null
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
    merchantId: params.merchantId ?? null,
  }
}

function productFilterHashInput(
  filters: NormalizedProductFilters,
  audience: ProductAudience = 'guest',
): Record<string, unknown> {
  return {
    query: filters.query,
    categoryCode: filters.categoryCode,
    legacyCategory: filters.legacyCategory,
    audience,
    // Unscoped lists keep their original hash so existing site-wide cursors stay valid.
    ...(filters.merchantId != null ? { merchantId: filters.merchantId } : {}),
  }
}

async function listRankedProductRows(
  params: ProductListParams,
  context: ProductListContext,
): Promise<RankedProductRow[]> {
  const { page = 1, pageSize = 20 } = params
  const { filters, cursor, run } = context
  const where: Prisma.Sql[] = [
    Prisma.sql`p."status" = 'active' AND p."archivedAt" IS NULL`,
    merchantVisibleSql(),
  ]
  if (params.audience === 'guest') where.push(guestVisibilitySql())
  if (filters.merchantId != null) where.push(Prisma.sql`p."merchantId" = ${filters.merchantId}`)

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
  const audience = params.audience ?? 'guest'
  const cursor = params.cursor ? decodeOrganicCursor(params.cursor) : null
  if (cursor) assertCursorFilterMatches(cursor, productFilterHashInput(filters, audience))
  const pinned = await resolveCursorForRequest(cursor)
  const run = pinned.mode === 'run' ? pinned.run : null
  const context: ProductListContext = { filters, cursor, run }
  const cacheKey = await buildProductListCacheKey({
    ...params,
    categoryCode: filters.categoryCode ?? undefined,
    category: filters.legacyCategory ?? undefined,
    rankingRunId: run?.id ?? null,
    audience,
  })

  const load = () => listProductsFromDb(params, context)
  const { data: baseResult } = cacheKey
    ? await wrapCache('product-list', cacheKey, params.query ? 10 : params.cursor ? 20 : 30, load, {
        // A cold public read returns unknown capacity while its Xboard probe runs in
        // the background. Judge by every evaluated offer, not the product summary or
        // representative snapshot, so a partly unknown page is never cached.
        cachePredicate: result => !result.hasUnknownFakaCapacity,
      })
    : await load()

  // Merch identity/entitlement is decorated after the Catalog cache, so expiry,
  // revocation and editorial changes never get frozen inside a product cache entry.
  const live = await prisma.product.findMany({
    where: { id: { in: baseResult.items.map(item => item.id) } },
    select: {
      id: true,
      status: true,
      archivedAt: true,
      visibility: true,
      merchantId: true,
      merchant: { select: { status: true } },
      // SPEC-CATALOG-VIS-001 §3.4：缓存命中后必须用实时分类可见性复核，
      // 不能信任缓存里那份可能已过期的判定结果。
      category: { select: { guestVisibility: true } },
      // SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入判定所需字段。
      contentVersion: true,
      publicContentRevision: true,
      guestEligibility: { select: { decision: true, reviewedRevision: true } },
    },
  })
  // A cached shop page must not keep showing a product that moved to another owner.
  const visible = new Set(
    live
      .filter(row => isCurrentlyPubliclyVisible(row, audience)
        && (params.merchantId == null || row.merchantId === params.merchantId))
      .map(row => row.id),
  )
  const visibleItems = baseResult.items.filter(item => visible.has(item.id))
  const decorated = await attachListMerchandising({
    ...baseResult,
    items: visibleItems,
  }, run)
  const assuranceById = await loadPublicAssuranceByProductIds(decorated.items.map(item => item.id))
  return {
    ...decorated,
    items: decorated.items.map(item => ({
      ...item,
      assurance: assuranceById.get(item.id) ?? null,
    })),
  }
}

/**
 * Batch-loads public list cards for already-ordered IDs (list page and recommendations).
 * Order follows `orderedIds`; missing or currently invisible products are dropped.
 */
async function hydratePublicListItems(orderedIds: number[], audience: ProductAudience) {
  const ids = [...new Set(orderedIds)]
  if (ids.length === 0) return { items: [], hasUnknownFakaCapacity: false }
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, ...publicVisibilityWhere(audience) },
    select: productListSelect,
  })
  // publicVisibilityWhere 对游客只做准入粗筛（Prisma where 无法跨表比较
  // reviewedRevision 与 publicContentRevision），这里补精判，
  // 否则「已批准但内容已改」的商品仍会出现在推荐/店铺卡片里。
  const visible = products.filter(product => isCurrentlyPubliclyVisible(product, audience))
  const productById = new Map(visible.map(product => [product.id, product]))
  const items = ids.flatMap(id => {
    const product = productById.get(id)
    return product ? [product] : []
  })

  const facts = await loadAvailabilityBatchFacts(items)
  const fakaBySku = loadFakaCapacityBySku(items.flatMap(item => item.offers))
  let hasUnknownFakaCapacity = false
  const cards = items.map(item => {
    const statuses = item.offers.map(offer =>
      publicOfferStatus(offer, item.merchant?.id ?? null, facts, fakaSnapshotForSku(offer, fakaBySku)),
    )
    if (statuses.includes('unknown')) hasUnknownFakaCapacity = true
    return serializePublicProductListItem(
      item,
      facts.offerAvailableCounts,
      fakaBySku,
      aggregateOfferAvailability(statuses),
    )
  })
  // The flag is an internal cache hint only; callers must not expose it.
  return { items: cards, hasUnknownFakaCapacity }
}

async function listProductsFromDb(params: ProductListParams, context: ProductListContext) {
  const { pageSize = 20 } = params
  const ranked = await listRankedProductRows(params, context)
  const pageRows = ranked.slice(0, pageSize)
  const { items, hasUnknownFakaCapacity } = await hydratePublicListItems(
    pageRows.map(row => row.id),
    params.audience === 'guest' ? 'guest' : 'member',
  )
  const lastRow = pageRows.at(-1)
  const hasMore = ranked.length > pageSize
  const filterHash = computeFilterHash(productFilterHashInput(context.filters, params.audience ?? 'guest'))

  return {
    data: {
      items,
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
    },
    hasUnknownFakaCapacity,
  }
}

export async function getProductDetail(id: number, audience: ProductAudience = 'guest') {
  const cacheKey = await buildProductDetailCacheKey(id, audience)
  let baseProduct = cacheKey
    ? await wrapCache('product-detail', cacheKey, 60, () => getProductDetailFromDb(id, audience), {
        negativeTtlSec: 20,
        negativeErrorPredicate: err => err instanceof HttpError && err.status === 404,
        // Same rule as the list: Redis may cache a known capacity/stale snapshot,
        // but never an offer whose capacity is still unknown (cold-cache SWR fallback).
        cachePredicate: result => result.offers.every(offer => offer.availability.status !== 'unknown'),
      })
    : await getProductDetailFromDb(id, audience)

  const live = await prisma.product.findUnique({
    where: { id },
    select: {
      status: true,
      contentVersion: true,
      archivedAt: true,
      visibility: true,
      merchantId: true,
      merchant: { select: { status: true } },
      category: { select: { guestVisibility: true } },
      // SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入判定所需字段。
      publicContentRevision: true,
      guestEligibility: { select: { decision: true, reviewedRevision: true } },
    },
  })
  if (!live) throw notFound('商品暂不可用')
  assertPublicProductAccess(live, audience)
  if (live.contentVersion !== baseProduct.contentVersion) {
    baseProduct = await getProductDetailFromDb(id, audience)
  }

  const pinned = await resolveCursorForRequest(null)
  const run = pinned.mode === 'run' ? pinned.run : null
  const [decorated] = await decorateProducts(
    [{ id: baseProduct.id, merchantId: baseProduct.merchant?.id ?? null }],
    run,
  )
  const assuranceById = await loadPublicAssuranceByProductIds([baseProduct.id])
  return {
    ...baseProduct,
    merchandising: decorated.merchandising,
    assurance: assuranceById.get(baseProduct.id) ?? null,
  }
}

async function getProductDetailFromDb(id: number, audience: ProductAudience = 'guest') {
  const product = await prisma.product.findUnique({
    where: { id },
    select: productDetailSelect,
  })
  if (!product) throw notFound('商品暂不可用')
  assertPublicProductAccess(product, audience)

  const facts = await loadAvailabilityBatchFacts([product])

  // FakaBridge：详情页只读缓存并后台刷新，绝不在请求内串行外呼 Xboard。
  // Same batch read as the list, so period SKUs of one plan share one snapshot/probe.
  const fakaBySku = loadFakaCapacityBySku(product.offers)
  const fakaByOfferId = new Map<number, FakaCapacitySnapshot>()
  for (const offer of product.offers) {
    const snapshot = fakaSnapshotForSku(offer, fakaBySku)
    if (snapshot) fakaByOfferId.set(offer.id, snapshot)
  }

  const offerStatusById = new Map(
    product.offers.map(offer => [
      offer.id,
      publicOfferStatus(offer, product.merchant?.id ?? null, facts, fakaByOfferId.get(offer.id) ?? null),
    ]),
  )
  return serializePublicProductDetail(product, facts.offerAvailableCounts, fakaByOfferId, offerStatusById)
}

const RECOMMENDATION_LIMIT = 6

/**
 * Same-seller-first related products (PLAN-PDP-REC-001). Relevance is decided once in SQL;
 * cards reuse the list hydration and the live merch/assurance projection. No result cache,
 * so the hydration query's visibility predicate is the only (and current) access check.
 */
export async function getProductRecommendations(id: number, audience: ProductAudience = 'guest') {
  const base = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      categoryId: true,
      merchantId: true,
      templateKey: true,
      templateVersion: true,
      status: true,
      archivedAt: true,
      visibility: true,
      merchant: { select: { status: true } },
      // SPEC-CATALOG-VIS-001 §3.3：源商品先鉴权，再逐批过滤候选。
      category: { select: { guestVisibility: true } },
      // SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入判定所需字段。
      publicContentRevision: true,
      guestEligibility: { select: { decision: true, reviewedRevision: true } },
    },
  })
  if (!base) throw notFound('商品暂不可用')
  assertPublicProductAccess(base, audience)

  const [sameCandidates, otherCandidates] = await Promise.all([
    queryRecommendationCandidates(base, audience, true),
    queryRecommendationCandidates(base, audience, false),
  ])
  const sameSellerIds = sameCandidates.map(row => row.id)
  const otherSellerIds = otherCandidates.map(row => row.id)
  const tiers = new Map([...sameCandidates, ...otherCandidates].map(row => [row.id, row.tier]))
  const sameSeller = new Set(sameSellerIds)
  const { items: cards } = await hydratePublicListItems([...sameSellerIds, ...otherSellerIds], audience)
  // Unknown capacity stays in its ranked position; only known-unsellable products drop out.
  const items = cards
    .filter(item => item.availability.status !== 'unavailable')
    .slice(0, RECOMMENDATION_LIMIT)

  const pinned = await resolveCursorForRequest(null)
  const decorated = await attachListMerchandising({ items }, pinned.mode === 'run' ? pinned.run : null)
  const assuranceById = await loadPublicAssuranceByProductIds(decorated.items.map(item => item.id))
  const listToken = signRecommendationList(id, audience, decorated.items.map((item, index) => ({
    id: item.id, pos: index + 1, tier: tiers.get(item.id)!, same: sameSeller.has(item.id),
    platform: item.merchant == null,
  })))
  return {
    productId: id,
    ...(listToken ? { tracking: { listToken } } : {}),
    items: decorated.items.map(item => ({
      ...item,
      assurance: assuranceById.get(item.id) ?? null,
      recommendation: { sameSeller: sameSeller.has(item.id) },
    })),
  }
}
