// T-CAT-BE-003 (SPEC-CATALOG-OPS-001 §6.1; D-CAT-03/D-CAT-04/D-CAT-22;
// REQ-CAT-F-002; CHK-PROD-003/004; AC-CAT-002/003).
//
// Publish readiness gate. All conditions are read authoritatively by the
// server in the SAME transaction as the publish action; the client "looking
// complete" can never bypass the gate (D-CAT-03).
//
// The publish transaction performs NO remote I/O. External-integration offers
// (FakaBridge) are validated against the last LOCAL provider-configuration
// state only (`isFakaBridgeConfigured` reads env config, never the network).
//
// Stable machine codes live in constants.ts (READINESS_DETAIL_CODES); clients
// must key off `details[].code`, never off `reason` prose (spec §6.1).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { isFakaBridgeConfigured } from '../../lib/fakaBridge/client.js'
import {
  CATEGORY_STATUS,
  READINESS_DETAIL_CODES,
  type ReadinessDetailCode,
} from './constants.js'

type Client = typeof prisma | Prisma.TransactionClient

export interface ReadinessDetail {
  /** Stable machine code (spec §6.1) — clients must key off this. */
  code: ReadinessDetailCode
  /** Affected logical field: images | category | offers | external. */
  field: string
  /** Target offer when the issue is offer-scoped, else null. */
  offerId: number | null
  /** Human-readable diagnostic only — NOT a stable machine code. */
  reason?: string
}

export interface ProductReadinessResult {
  ready: boolean
  /** True when publishedAt is null → category must be active (D-CAT-22). */
  isFirstPublish: boolean
  details: ReadinessDetail[]
}

export interface CheckProductReadinessOptions {
  /**
   * Injectable local Faka provider-config check. Defaults to the env-backed
   * `isFakaBridgeConfigured`. Used by tests to avoid process-global env state.
   */
  isProviderConfigured?: () => boolean
}

const readinessProductSelect = {
  id: true,
  name: true,
  imageUrl: true,
  images: true,
  merchantId: true,
  status: true,
  publishedAt: true,
  category: { select: { id: true, status: true } },
  offers: {
    select: {
      id: true,
      status: true,
      deliveryMode: true,
      stockMode: true,
      stock: true,
      fixedContent: true,
      fixedContentType: true,
      fixedFileId: true,
      autoProvision: true,
      externalIntegration: true,
      externalSku: true,
      _count: { select: { inventory: { where: { status: 'available' } } } },
    },
  },
} satisfies Prisma.ProductSelect

type ReadinessProductRow = Prisma.ProductGetPayload<{ select: typeof readinessProductSelect }>

interface OfferEvaluation {
  externalInvalid?: boolean
  configValid: boolean
  sellable: boolean
  reason?: string
}

function detail(
  code: ReadinessDetailCode,
  field: string,
  offerId: number | null,
  reason?: string,
): ReadinessDetail {
  return { code, field, offerId, reason }
}

/**
 * Evaluate one active offer's commercial/fulfilment config and current
 * sellability. Pure sync decision tree — the only async inputs (available
 * inventory count, auto-provision webhook presence) are resolved by the
 * caller before invoking.
 */
function evaluateActiveOffer(
  offer: ReadinessProductRow['offers'][number],
  availableInventory: number,
  hasActiveWebhook: boolean,
  isProviderConfigured: () => boolean,
): OfferEvaluation {
  // External-integration offers (spec §6.1 #6): DB unique `(externalIntegration,
  // externalSku)` guarantees identity uniqueness; here we only re-check that the
  // local provider config is still valid. NO network call in the publish txn.
  if (offer.externalIntegration === 'faka_bridge') {
    if (!offer.externalSku) {
      return {
        externalInvalid: true,
        configValid: false,
        sellable: false,
        reason: 'FakaBridge 规格缺少 externalSku',
      }
    }
    if (!isProviderConfigured()) {
      return {
        externalInvalid: true,
        configValid: false,
        sellable: false,
        reason: '平台尚未配置 FakaBridge',
      }
    }
    if (offer.deliveryMode !== 'manual_service') {
      return {
        configValid: false,
        sellable: false,
        reason: 'FakaBridge 规格的履约模式必须为 manual_service',
      }
    }
    const sellable = offer.stockMode === 'unlimited' || offer.stock > 0
    return {
      configValid: true,
      sellable,
      reason: sellable ? undefined : '该规格当前没有可售名额',
    }
  }

  switch (offer.deliveryMode) {
    case 'instant_inventory': {
      // One available InventoryItem per deliverable secret (spec §6.1 #5).
      const configValid = offer.stockMode === 'limited'
      const sellable = configValid && availableInventory > 0
      return {
        configValid,
        sellable,
        reason: configValid
          ? sellable ? undefined : '该规格没有可用的交付库存'
          : '即时库存规格必须为限量库存',
      }
    }
    case 'instant_fixed': {
      // fixed content/file must be complete (spec §6.1 #5).
      const contentValid =
        offer.fixedContentType === 'file'
          ? offer.fixedFileId != null
          : Boolean(offer.fixedContent?.trim())
      const configValid = contentValid
      const sellable = configValid && (offer.stockMode === 'unlimited' || offer.stock > 0)
      return {
        configValid,
        sellable,
        reason: configValid
          ? sellable ? undefined : '该规格当前可售名额为 0'
          : '固定内容规格缺少交付内容',
      }
    }
    case 'manual_service': {
      // 人工/自动/Faka 配置完整（spec §6.1 #5）。Faka handled above.
      let configValid = true
      let configReason: string | undefined
      if (offer.autoProvision && !hasActiveWebhook) {
        configValid = false
        configReason = '自动开通规格缺少可用的商家 webhook 配置'
      }
      const sellable = configValid && (offer.stockMode === 'unlimited' || offer.stock > 0)
      return {
        configValid,
        sellable,
        reason: configValid
          ? sellable ? undefined : '该规格当前可售名额为 0'
          : configReason,
      }
    }
    default:
      return { configValid: false, sellable: false, reason: '未知的履约模式' }
  }
}

/**
 * Readiness gate (spec §6.1). Reads the product, its category and its offers in
 * one authoritative snapshot; `db` is usually the caller's transaction client
 * so the gate and the status CAS share one transaction.
 */
export async function checkProductReadiness(
  productId: number,
  db: Client = prisma,
  options: CheckProductReadinessOptions = {},
): Promise<ProductReadinessResult> {
  const isProviderConfigured = options.isProviderConfigured ?? isFakaBridgeConfigured
  const product = await db.product.findUnique({
    where: { id: productId },
    select: readinessProductSelect,
  })
  if (!product) throw notFound('商品不存在')

  const details: ReadinessDetail[] = []
  const isFirstPublish = product.publishedAt == null

  // §6.1 #3 — canonical cover: images[0] == imageUrl and non-empty.
  const cover = (product.images[0] ?? null)?.trim() || null
  const imageUrl = product.imageUrl?.trim() || null
  if (!cover || !imageUrl || cover !== imageUrl) {
    details.push(
      detail(
        READINESS_DETAIL_CODES.COVER_REQUIRED,
        'images',
        null,
        '商品缺少规范封面或封面与图片列表不一致',
      ),
    )
  }

  // §6.1 #2 — first publish requires an active category; historical published
  // products may keep an inactive category (D-CAT-22).
  if (isFirstPublish && product.category.status !== CATEGORY_STATUS.ACTIVE) {
    details.push(
      detail(
        READINESS_DETAIL_CODES.CATEGORY_INACTIVE,
        'category',
        null,
        '首次发布必须使用启用状态的商品分类',
      ),
    )
  }

  // §6.1 #4/#5/#6 — active offers, per-offer config validity, at least one
  // sellable active offer, external identity validity.
  const activeOffers = product.offers.filter(offer => offer.status === 'active')

  let sellableCount = 0
  const validButEmpty: ReadinessProductRow['offers'][number][] = []

  if (activeOffers.length === 0) {
    details.push(
      detail(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE, 'offers', null, '商品没有启用状态的规格'),
    )
  } else {
    // Resolve auto-provision webhook presence once per product (local DB read).
    const autoProvisionOffers = activeOffers.filter(offer => offer.autoProvision)
    let hasActiveWebhook = false
    if (autoProvisionOffers.length > 0 && product.merchantId != null) {
      const count = await db.merchantWebhookConfig.count({
        where: { merchantId: product.merchantId, status: 'active' },
      })
      hasActiveWebhook = count > 0
    }

    for (const offer of activeOffers) {
      const evaluation = evaluateActiveOffer(
        offer,
        offer._count.inventory,
        hasActiveWebhook,
        isProviderConfigured,
      )
      if (evaluation.externalInvalid) {
        details.push(
          detail(
            READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID,
            'offers',
            offer.id,
            evaluation.reason,
          ),
        )
      } else if (!evaluation.configValid) {
        details.push(
          detail(
            READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE,
            'offers',
            offer.id,
            evaluation.reason,
          ),
        )
      } else if (evaluation.sellable) {
        sellableCount += 1
      } else {
        validButEmpty.push(offer)
      }
    }

    // §6.1 #5 — at least one active offer must currently be sellable.
    if (sellableCount === 0) {
      for (const offer of validButEmpty) {
        details.push(
          detail(
            READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE,
            'offers',
            offer.id,
            '该规格当前不可售',
          ),
        )
      }
    }
  }

  return {
    ready: details.length === 0,
    isFirstPublish,
    details,
  }
}
