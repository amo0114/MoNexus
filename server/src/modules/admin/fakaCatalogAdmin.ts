import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError, type ErrorCode } from '../../lib/httpError.js'
import { createDefaultOffer } from '../../lib/offers.js'
import {
  callFakaPlanCatalog,
  callFakaSetPlanCapacity,
  fetchFakaCapacityForSku,
  invalidateFakaCapacityCache,
  isFakaBridgeConfigured,
  normalizeFakaOfferIntegration,
} from '../../lib/fakaBridge/index.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { resolveProductCategory } from '../catalog/resolver.js'
import {
  MediaRefResolutionError,
  resolveLegacyPlatformImageUrl,
  resolvePlatformPublicImage,
} from '../catalog/platformMedia.js'
import { CATALOG_ERROR_CODES, EXTERNAL_CATALOG_PROVIDER } from '../catalog/constants.js'
import {
  buildExternalCatalogRequestHash,
  fetchNormalizedFakaSource,
  normalizeExternalCatalogRequest,
  validateExternalCatalogIdempotencyKey,
  type ExternalCatalogRequestInput,
  type NormalizedFakaSource,
} from '../catalog/externalCatalog.js'
import { EMPTY_PRODUCT_DETAILS } from '../catalog/templates/types.js'

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

function clipCatalogText(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

type FakaImportDb = typeof prisma | Prisma.TransactionClient

type FakaImportIssue = { code: string; field: string; message: string; action?: string }

/**
 * Cover sub-case that maps to a user-facing `action` (plan §4.2).
 * Never surfaced raw — always projected to COVER_INVALID + action.
 */
class CoverResolutionError extends Error {
  constructor(
    public readonly reason: 'object_missing' | 'category_default_missing',
    message: string,
  ) {
    super(message)
    this.name = 'CoverResolutionError'
  }
}

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
    if (!category.defaultCoverUrl) {
      throw new CoverResolutionError('category_default_missing', '该分类尚未配置可用默认封面')
    }
    const resolved = await resolveLegacyPlatformImageUrl(category.defaultCoverUrl, db)
    return { imageUrl: resolved.canonicalUrl, images: [resolved.canonicalUrl] }
  }
  // uploaded: objectKey is the write/confirm trust anchor (D-UX-13) and is
  // re-validated server-side against the StoredObject registry every time.
  const resolved = await resolvePlatformPublicImage(
    { kind: 'upload', objectKey: input.cover.objectKey },
    db,
  )
  return { imageUrl: resolved.canonicalUrl, images: [resolved.canonicalUrl] }
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
    select: { productId: true, product: { select: { archivedAt: true } } },
  })
  if (linked) {
    if (linked.product.archivedAt) {
      issues.push({
        code: 'PLAN_ARCHIVED',
        field: 'planId',
        message: `该套餐已关联已归档商品 ${linked.productId}`,
        action: 'restore_product',
      })
    } else {
      issues.push({ code: 'PLAN_ALREADY_IMPORTED', field: 'planId', message: `该套餐已关联商品 ${linked.productId}` })
    }
  }

  let cover: { imageUrl: string; images: string[] } | null = null
  try {
    cover = await resolveFakaImportCover(db, input)
  } catch (error) {
    // Map resolution failures to COVER_INVALID + an `action` the frontend can
    // project without branching on Chinese prose (plan §4.2 / CHK §4).
    if (error instanceof CoverResolutionError) {
      issues.push({
        code: 'COVER_INVALID',
        field: 'cover',
        message: error.message,
        action: error.reason === 'category_default_missing' ? 'set_category_cover' : 'reupload_cover',
      })
    } else if (error instanceof MediaRefResolutionError) {
      issues.push({
        code: 'COVER_INVALID',
        field: 'cover',
        message: error.message,
        action: 'reupload_cover',
      })
    } else {
      throw error
    }
  }
  const productName = request.productName || source.name || `Xboard 套餐 #${input.planId}`
  const plainDescription = source.plainDescription || `${productName} · 含 ${offers.map(row => row.offerName).join(' / ')} 等规格`
  const archivedLink = linked?.product.archivedAt ? linked : null
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
    existingProductId: linked?.productId ?? null,
    archived: Boolean(archivedLink),
    suggestedActions: archivedLink ? ['restore_product', 'sync'] : [],
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
    select: { productId: true, product: { select: { archivedAt: true } } },
  })
  if (existingByPlan) {
    if (existingByPlan.product.archivedAt) {
      throw new HttpError(409, CATALOG_ERROR_CODES.PRODUCT_ARCHIVED as ErrorCode, '该 Xboard 套餐已导入且商品已归档', [
        { field: 'existingProductId', message: String(existingByPlan.productId) },
        { field: 'archived', message: 'true' },
        { field: 'action', message: 'restore_product' },
      ])
    }
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
      const publicationCopy = clipCatalogText(
        transactional.plainDescription || `${transactional.productName} · 导入套餐摘要`,
        2000,
      )
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
          templateKey: 'subscription',
          templateVersion: 1,
          visibility: 'members_only',
          attributes: {
            serviceName: clipCatalogText(transactional.productName, 100),
            serviceScope: clipCatalogText(publicationCopy, 1000),
          } as Prisma.InputJsonValue,
          details: { ...EMPTY_PRODUCT_DETAILS } as Prisma.InputJsonValue,
        },
      })
      const defaultOffer = await createDefaultOffer(tx, created.id, {
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
      await tx.offer.update({
        where: { id: defaultOffer.id },
        data: {
          attributes: {
            entitlementSummary: clipCatalogText(`${defaultRow.offerName} · ${publicationCopy}`, 500),
          } as Prisma.InputJsonValue,
        },
      })
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
            attributes: {
              entitlementSummary: clipCatalogText(`${row.offerName} · ${publicationCopy}`, 500),
            } as Prisma.InputJsonValue,
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
