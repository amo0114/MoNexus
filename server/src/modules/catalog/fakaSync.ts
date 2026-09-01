import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import { syncProductProjection } from '../../lib/offers.js'
import { normalizeFakaOfferIntegration } from '../../lib/fakaBridge/index.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { lockProductRow } from '../admin/productLifecycle.js'
import { assertOriginalPrice, countOpenFakaTasksForOffer } from '../admin/offerAdmin.js'
import {
  fakaCatalogSkuSet,
  fetchNormalizedFakaSource,
  sha256Canonical,
  validateExternalCatalogIdempotencyKey,
  type NormalizedFakaSource,
} from './externalCatalog.js'
import { CATALOG_ERROR_CODES, EXTERNAL_CATALOG_PROVIDER, PRODUCT_STATUS } from './constants.js'

const PERIOD_OFFER_LABELS: Record<string, string> = {
  monthly: '月付',
  quarterly: '季付',
  half_yearly: '半年付',
  yearly: '年付',
  two_yearly: '两年付',
  three_yearly: '三年付',
  onetime: '流量包',
  reset_traffic: '重置包',
}

const PERIOD_VALIDITY_DAYS: Record<string, number | null> = {
  monthly: 30,
  quarterly: 90,
  half_yearly: 180,
  yearly: 365,
  two_yearly: 730,
  three_yearly: 1095,
  onetime: null,
  reset_traffic: null,
}

export type FakaSyncActionType =
  | 'add_missing'
  | 'archive_removed'
  | 'keep_local'
  | 'restore_product'
  | 'update_sku'
  | 'apply_price'

export type FakaSyncAction = {
  type: FakaSyncActionType
  period?: string
  offerId?: number
  sku?: string
  pricePoints?: number
  offerName?: string
  validityDays?: number | null
}

export type FakaSyncConfirmInput = {
  sourceHash: string
  actions?: FakaSyncAction[]
}

type LocalOffer = {
  id: number
  name: string
  price: number
  originalPrice: number | null
  status: string
  isDefault: boolean
  sortOrder: number
  validityDays: number | null
  externalSku: string | null
  externalIntegration: string | null
}

function inferPeriod(
  sku: string | null,
  planId: number,
  namedSkus: Array<{ period: string; sku: string }>,
): string | null {
  if (!sku) return null
  const named = namedSkus.find(row => row.sku === sku)
  if (named) return named.period
  const prefix = `plan-${planId}-`
  if (sku.startsWith(prefix)) return sku.slice(prefix.length)
  return null
}

function suggestedActions(input: {
  productArchived: boolean
  added: Array<{ period: string }>
  removed: Array<{ offerId: number }>
  skuChanged: Array<{ offerId: number }>
}): FakaSyncActionType[] {
  const actions: FakaSyncActionType[] = []
  if (input.productArchived) actions.push('restore_product')
  if (input.added.length > 0) actions.push('add_missing')
  if (input.removed.length > 0) actions.push('archive_removed')
  if (input.skuChanged.length > 0) actions.push('update_sku')
  actions.push('keep_local')
  return actions
}

export async function previewAdminFakaSync(productId: number) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      externalCatalogLink: true,
      offers: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      },
    },
  })
  if (!product) throw notFound('商品不存在')
  const link = product.externalCatalogLink
  if (!link) {
    throw badRequest('该商品不是 Xboard 导入商品')
  }
  const planId = Number(link.externalProductId)
  if (!Number.isInteger(planId) || planId <= 0) {
    throw badRequest('外部套餐身份无效')
  }
  const source = await fetchNormalizedFakaSource(planId)
  return buildFakaSyncDiff({ ...product, externalCatalogLink: link }, source)
}

function buildFakaSyncDiff(
  product: {
    id: number
    name: string
    description: string | null
    archivedAt: Date | null
    status: string
    offers: LocalOffer[]
    externalCatalogLink: {
      sourceHash: string
      sourceSnapshot: Prisma.JsonValue
      externalProductId: string
    }
  },
  source: NormalizedFakaSource,
) {
  const planId = source.planId
  const fakaOffers = product.offers.filter(o => o.externalIntegration === 'faka_bridge')
  const localByPeriod = new Map<string, LocalOffer>()
  for (const offer of fakaOffers) {
    const period = inferPeriod(offer.externalSku, planId, source.namedSkus)
    if (period) localByPeriod.set(period, offer)
  }

  const added = source.periods
    .filter(row => !localByPeriod.has(row.period))
    .map(row => ({
      period: row.period,
      sku: source.namedSkus.find(item => item.period === row.period)?.sku || row.skuAlias,
      remotePriceHint: row.price,
      suggestedName: PERIOD_OFFER_LABELS[row.period] || row.period,
      suggestedValidityDays: PERIOD_VALIDITY_DAYS[row.period] ?? null,
    }))

  const removed = fakaOffers.flatMap(offer => {
    const period = inferPeriod(offer.externalSku, planId, source.namedSkus)
    if (period && source.periods.some(row => row.period === period)) return []
    return [{
      offerId: offer.id,
      name: offer.name,
      sku: offer.externalSku,
      period,
      status: offer.status,
      price: offer.price,
    }]
  })

  const skuChanged = fakaOffers.flatMap(offer => {
    const period = inferPeriod(offer.externalSku, planId, source.namedSkus)
    if (!period) return []
    const remote = source.periods.find(row => row.period === period)
    if (!remote) return []
    const expectedSku = source.namedSkus.find(item => item.period === period)?.sku || remote.skuAlias
    if (!expectedSku || expectedSku === offer.externalSku) return []
    return [{
      offerId: offer.id,
      period,
      from: offer.externalSku,
      to: expectedSku,
    }]
  })

  const kept = fakaOffers.flatMap(offer => {
    const period = inferPeriod(offer.externalSku, planId, source.namedSkus)
    if (!period || !source.periods.some(row => row.period === period)) return []
    const remote = source.periods.find(row => row.period === period)!
    return [{
      offerId: offer.id,
      period,
      name: offer.name,
      status: offer.status,
      localPricePoints: offer.price,
      remotePriceHint: remote.price,
      sku: offer.externalSku,
    }]
  })

  return {
    productId: product.id,
    productName: product.name,
    archived: product.archivedAt != null,
    productStatus: product.status,
    sourceHash: source.sourceHash,
    currentSourceHash: product.externalCatalogLink.sourceHash,
    sourceChanged: source.sourceHash !== product.externalCatalogLink.sourceHash,
    plan: {
      showSell: source.capacity.sellable,
      capacity: source.capacity,
      name: source.name,
      plainDescription: source.plainDescription,
      localDescription: product.description,
    },
    added,
    removed,
    skuChanged,
    kept,
    suggestedActions: suggestedActions({
      productArchived: product.archivedAt != null,
      added,
      removed,
      skuChanged,
    }),
    ownership: {
      xboard: ['identity', 'availability', 'period', 'sku', 'capacity'],
      monexus: ['pointsPrice', 'displayName', 'category', 'cover', 'sort'],
    },
  }
}

type FakaSyncDiff = ReturnType<typeof buildFakaSyncDiff>

function fakaActionNotInDiff(): HttpError {
  return new HttpError(
    400,
    CATALOG_ERROR_CODES.FAKA_ACTION_NOT_IN_DIFF as ErrorCode,
    '同步动作不属于当前预览 diff',
  )
}

function bindSubmittedFakaActions(
  submitted: FakaSyncAction[],
  diff: FakaSyncDiff,
  source: NormalizedFakaSource,
): FakaSyncAction[] {
  return submitted.map(action => bindSubmittedFakaAction(action, diff, source))
}

function bindSubmittedFakaAction(
  action: FakaSyncAction,
  diff: FakaSyncDiff,
  source: NormalizedFakaSource,
): FakaSyncAction {
  if (action.type === 'keep_local') return { type: 'keep_local' }
  if (action.type === 'restore_product') {
    if (!diff.archived) throw fakaActionNotInDiff()
    return { type: 'restore_product' }
  }
  if (action.type === 'add_missing') {
    const period = action.period?.trim().toLowerCase()
    const added = period ? diff.added.find(row => row.period === period) : undefined
    if (!period || !added) throw fakaActionNotInDiff()
    const sku = (action.sku || added.sku).trim().toLowerCase()
    if (sku !== added.sku.toLowerCase() || !fakaCatalogSkuSet(source, period).has(sku)) {
      throw fakaActionNotInDiff()
    }
    if (action.pricePoints == null) {
      throw new HttpError(
        400,
        CATALOG_ERROR_CODES.FAKA_PRICE_CHANGE_REQUIRES_CONFIRM as ErrorCode,
        '新增规格必须显式提供积分价，同步不会套用 Xboard 金额',
      )
    }
    return {
      type: 'add_missing',
      period,
      sku,
      pricePoints: action.pricePoints,
      offerName: action.offerName,
      validityDays: action.validityDays,
    }
  }
  if (action.type === 'archive_removed') {
    if (action.offerId == null || !diff.removed.some(row => row.offerId === action.offerId)) {
      throw fakaActionNotInDiff()
    }
    return { type: 'archive_removed', offerId: action.offerId }
  }
  if (action.type === 'update_sku') {
    const changed = action.offerId == null
      ? undefined
      : diff.skuChanged.find(row => row.offerId === action.offerId)
    const sku = action.sku?.trim().toLowerCase()
    if (!changed || !sku || sku !== changed.to || !fakaCatalogSkuSet(source, changed.period).has(sku)) {
      throw fakaActionNotInDiff()
    }
    return { type: 'update_sku', offerId: changed.offerId, sku, period: changed.period }
  }
  if (action.type === 'apply_price') {
    if (action.offerId == null || action.pricePoints == null) {
      throw new HttpError(
        400,
        CATALOG_ERROR_CODES.FAKA_PRICE_CHANGE_REQUIRES_CONFIRM as ErrorCode,
        '改积分价必须在 diff 中显式确认 offerId 与 pricePoints',
      )
    }
    if (!diff.kept.some(row => row.offerId === action.offerId)) throw fakaActionNotInDiff()
    return { type: 'apply_price', offerId: action.offerId, pricePoints: action.pricePoints }
  }
  throw fakaActionNotInDiff()
}

const SYNC_IDEMPOTENCY_PROVIDER = EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE

async function claimFakaSyncIdempotency(
  tx: Prisma.TransactionClient,
  input: {
    productId: number
    idempotencyKey: string
    requestHash: string
    sourceHash: string
  },
): Promise<{ replayed: true; sourceHash: string } | { replayed: false }> {
  // ON CONFLICT DO NOTHING keeps the surrounding transaction usable.
  // A thrown unique violation would abort the Postgres transaction.
  const inserted = await tx.$queryRaw<Array<{ id: number }>>`
    INSERT INTO "ExternalCatalogSyncIdempotency"
      ("provider", "productId", "idempotencyKey", "requestHash", "sourceHash")
    VALUES (
      ${SYNC_IDEMPOTENCY_PROVIDER},
      ${input.productId},
      ${input.idempotencyKey},
      ${input.requestHash},
      ${input.sourceHash}
    )
    ON CONFLICT ("provider", "idempotencyKey") DO NOTHING
    RETURNING id
  `
  if (inserted.length > 0) return { replayed: false }
  const existing = await tx.externalCatalogSyncIdempotency.findUnique({
    where: {
      provider_idempotencyKey: {
        provider: SYNC_IDEMPOTENCY_PROVIDER,
        idempotencyKey: input.idempotencyKey,
      },
    },
  })
  if (!existing) {
    throw new HttpError(409, 'CONFLICT', '同步幂等键冲突，请重试')
  }
  if (existing.requestHash !== input.requestHash) {
    throw new HttpError(409, CATALOG_ERROR_CODES.IDEMPOTENCY_KEY_REUSED as ErrorCode, '该幂等键已用于不同请求')
  }
  return { replayed: true, sourceHash: existing.sourceHash }
}

export async function confirmAdminFakaSync(
  adminUserId: number,
  productId: number,
  input: FakaSyncConfirmInput,
  idempotencyKeyRaw?: string | null,
) {
  const key = validateExternalCatalogIdempotencyKey(idempotencyKeyRaw)
  const requestHash = sha256Canonical({
    v: 1,
    kind: 'faka-sync',
    productId,
    sourceHash: input.sourceHash,
    actions: input.actions ?? [],
  })

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      externalCatalogLink: true,
      offers: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!product) throw notFound('商品不存在')
  if (!product.externalCatalogLink) throw badRequest('该商品不是 Xboard 导入商品')
  const link = product.externalCatalogLink

  const planId = Number(link.externalProductId)
  const source = await fetchNormalizedFakaSource(planId)
  if (source.sourceHash !== input.sourceHash) {
    throw new HttpError(409, CATALOG_ERROR_CODES.FAKA_SOURCE_CHANGED as ErrorCode, 'Xboard 套餐已变化，请重新预览')
  }

  const actions = input.actions ?? []
  let diff = buildFakaSyncDiff({ ...product, externalCatalogLink: link }, source)

  try {
  const outcome = await prisma.$transaction(async tx => {
    await lockProductRow(tx, productId)
    const claimed = await claimFakaSyncIdempotency(tx, {
      productId,
      idempotencyKey: key,
      requestHash,
      sourceHash: source.sourceHash,
    })
    if (claimed.replayed) {
      return { replayed: true as const, sourceHash: claimed.sourceHash }
    }
    const fresh = await tx.product.findUniqueOrThrow({
      where: { id: productId },
      include: {
        externalCatalogLink: true,
        offers: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      },
    })
    if (!fresh.externalCatalogLink) throw badRequest('该商品不是 Xboard 导入商品')
    diff = buildFakaSyncDiff({ ...fresh, externalCatalogLink: fresh.externalCatalogLink }, source)
    const bound = bindSubmittedFakaActions(actions, diff, source)

    if (bound.some(action => action.type === 'restore_product') && fresh.archivedAt) {
      await tx.product.update({
        where: { id: productId },
        data: {
          status: fresh.publishedAt == null ? PRODUCT_STATUS.DRAFT : PRODUCT_STATUS.INACTIVE,
          archivedAt: null,
          archivedByUserId: null,
          archiveReason: null,
        },
      })
    }

    const maxSort = fresh.offers.reduce((max, offer) => Math.max(max, offer.sortOrder ?? 0), 0)
    let created = 0
    for (const action of bound) {
      if (action.type === 'add_missing') {
        const period = action.period!
        const sku = action.sku!
        const faka = normalizeFakaOfferIntegration({
          externalIntegration: 'faka_bridge',
          externalSku: sku,
          deliveryMode: 'manual_service',
        }, { requireConfigured: true })
        await tx.offer.create({
          data: {
            productId,
            name: action.offerName?.trim() || PERIOD_OFFER_LABELS[period] || period,
            isDefault: false,
            price: action.pricePoints!,
            originalPrice: null,
            deliveryMode: 'manual_service',
            stockMode: 'unlimited',
            stock: 0,
            validityDays: action.validityDays !== undefined
              ? action.validityDays
              : (PERIOD_VALIDITY_DAYS[period] ?? null),
            externalIntegration: faka.externalIntegration,
            externalSku: faka.externalSku,
            sortOrder: maxSort + 1 + created,
            status: 'inactive',
          },
        })
        created += 1
      }

      if (action.type === 'archive_removed' && action.offerId != null) {
        const offer = fresh.offers.find(row => row.id === action.offerId)
        if (!offer) throw notFound('规格不存在')
        if (offer.isDefault) {
          const replacement = fresh.offers.find(row => row.id !== offer.id && row.status === 'active')
            ?? fresh.offers.find(row => row.id !== offer.id)
          if (!replacement) {
            throw new HttpError(
              400,
              CATALOG_ERROR_CODES.DEFAULT_OFFER_ARCHIVE_BLOCKED as ErrorCode,
              '默认规格归档前请先指定另一个默认规格，或改为归档整个商品',
            )
          }
          await tx.offer.updateMany({
            where: { productId, isDefault: true },
            data: { isDefault: false },
          })
          await tx.offer.update({
            where: { id: replacement.id },
            data: { isDefault: true },
          })
        }
        await tx.offer.update({
          where: { id: offer.id },
          data: { status: 'inactive' },
        })
      }

      if (action.type === 'update_sku' && action.offerId != null) {
        const offer = fresh.offers.find(row => row.id === action.offerId)
        if (!offer) throw notFound('规格不存在')
        const openTasks = await countOpenFakaTasksForOffer(tx, offer.id)
        if (openTasks > 0) {
          throw new HttpError(409, CATALOG_ERROR_CODES.FAKA_OPEN_TASK as ErrorCode, '存在未结 FakaBridge 任务，拒绝重绑 SKU')
        }
        const faka = normalizeFakaOfferIntegration({
          externalIntegration: 'faka_bridge',
          externalSku: action.sku!,
          deliveryMode: offer.deliveryMode,
        }, { requireConfigured: true })
        await tx.offer.update({
          where: { id: offer.id },
          data: {
            externalIntegration: faka.externalIntegration,
            externalSku: faka.externalSku,
          },
        })
      }

      if (action.type === 'apply_price' && action.offerId != null && action.pricePoints != null) {
        const offer = fresh.offers.find(row => row.id === action.offerId)
        if (!offer) throw notFound('规格不存在')
        assertOriginalPrice(action.pricePoints, offer.originalPrice)
        await tx.offer.update({
          where: { id: offer.id },
          data: { price: action.pricePoints },
        })
      }
    }

    await tx.externalCatalogLink.update({
      where: { productId },
      data: {
        sourceHash: source.sourceHash,
        sourceSnapshot: source.sourceSnapshot as Prisma.InputJsonValue,
      },
    })
    await syncProductProjection(tx, productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '同步Xboard商品',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({
          idempotencyKey: key,
          requestHash,
          sourceHash: source.sourceHash,
          actions: actions.map(action => ({ type: action.type, period: action.period, offerId: action.offerId })),
          suggested: diff.suggestedActions,
        }),
      },
    })
    return { replayed: false as const, sourceHash: source.sourceHash }
  })

  await invalidateProductPublicCache(productId, { list: true, detail: true })
  return {
    productId,
    replayed: outcome.replayed,
    sourceHash: outcome.sourceHash,
    suggestedActions: diff.suggestedActions,
  }
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const existing = await prisma.externalCatalogSyncIdempotency.findUnique({
      where: {
        provider_idempotencyKey: {
          provider: SYNC_IDEMPOTENCY_PROVIDER,
          idempotencyKey: key,
        },
      },
    })
    if (existing) {
      if (existing.requestHash === requestHash) {
        return { productId, replayed: true, sourceHash: existing.sourceHash, suggestedActions: diff.suggestedActions }
      }
      throw new HttpError(409, CATALOG_ERROR_CODES.IDEMPOTENCY_KEY_REUSED as ErrorCode, '该幂等键已用于不同请求')
    }
    throw new HttpError(409, 'CONFLICT', '该 Xboard 商品或规格已存在')
  }
}
