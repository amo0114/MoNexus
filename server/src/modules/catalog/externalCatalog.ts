import { createHash } from 'node:crypto'
import type { FakaBridgeClientOptions } from '../../lib/fakaBridge/client.js'
import type { FakaPlanCatalogItem } from '../../lib/fakaBridge/types.js'
import { callFakaPlanCatalog } from '../../lib/fakaBridge/index.js'
import { badRequest, HttpError, type ErrorCode } from '../../lib/httpError.js'
import { CATALOG_ERROR_CODES } from './constants.js'
import { catalogPlainTextSummary, sanitizeCatalogRichContent } from './contentSanitizer.js'

export const EXTERNAL_CATALOG_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export type ExternalCatalogCoverChoice =
  | { mode: 'uploaded'; imageUrl: string; images?: string[] }
  | { mode: 'category_default' }

export interface ExternalCatalogOfferInput {
  period: string
  sku?: string
  offerName?: string
  pricePoints: number
  validityDays?: number | null
}

export interface ExternalCatalogRequestInput {
  planId: number
  productName?: string
  categoryId: number
  cover: ExternalCatalogCoverChoice
  offers?: ExternalCatalogOfferInput[]
  period?: string
  sku?: string
  offerName?: string
  pricePoints?: number
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function validateExternalCatalogIdempotencyKey(raw: string | null | undefined): string {
  if (raw == null || raw.trim() === '') {
    throw badRequest('缺少 Idempotency-Key', CATALOG_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED as ErrorCode)
  }
  const key = raw.trim()
  if (!EXTERNAL_CATALOG_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest('Idempotency-Key 格式无效', CATALOG_ERROR_CODES.IDEMPOTENCY_KEY_INVALID as ErrorCode)
  }
  return key
}

export function normalizeExternalCatalogRequest(input: ExternalCatalogRequestInput) {
  const offers = input.offers?.length
    ? input.offers
    : input.period && input.pricePoints != null
      ? [{
          period: input.period,
          sku: input.sku,
          offerName: input.offerName,
          pricePoints: input.pricePoints,
        }]
      : []
  return {
    planId: input.planId,
    productName: input.productName?.trim() || null,
    categoryId: input.categoryId,
    cover: input.cover.mode === 'uploaded'
      ? {
          mode: 'uploaded' as const,
          imageUrl: input.cover.imageUrl.trim(),
          images: (input.cover.images?.length ? input.cover.images : [input.cover.imageUrl])
            .map(value => value.trim()),
        }
      : { mode: 'category_default' as const },
    offers: offers.map(row => ({
      period: row.period.trim().toLowerCase(),
      sku: row.sku?.trim().toLowerCase() || null,
      offerName: row.offerName?.trim() || null,
      pricePoints: row.pricePoints,
      validityDays: row.validityDays,
    })),
  }
}

export function buildExternalCatalogRequestHash(input: ExternalCatalogRequestInput, sourceHash: string): string {
  return sha256Canonical({
    v: 1,
    provider: 'faka_bridge',
    sourceHash,
    request: normalizeExternalCatalogRequest(input),
  })
}

export interface NormalizedFakaSource {
  planId: number
  name: string
  richDescription: string | null
  plainDescription: string
  periods: Array<{ period: string; price: number; skuAlias: string }>
  namedSkus: Array<{ period: string; sku: string }>
  sourceHash: string
  capacity: {
    limit: number | null
    activeUsers: number
    remaining: number | null
    sellable: boolean
  }
  sourceSnapshot: {
    planId: number
    name: string
    periods: Array<{ period: string; price: number; skuAlias: string }>
    namedSkus: Array<{ period: string; sku: string }>
  }
}

export function normalizeFakaSource(plan: FakaPlanCatalogItem): NormalizedFakaSource {
  const periods = (plan.periods ?? []).map(row => ({
    period: row.period.trim().toLowerCase(),
    price: row.price,
    skuAlias: row.sku_alias.trim().toLowerCase(),
  }))
  const namedSkus = (plan.named_skus ?? []).map(row => ({
    period: row.period.trim().toLowerCase(),
    sku: row.sku.trim().toLowerCase(),
  }))
  const richDescription = sanitizeCatalogRichContent(plan.content)
  const sourceSnapshot = {
    planId: plan.plan_id,
    name: plan.name.trim(),
    periods,
    namedSkus,
  }
  return {
    ...sourceSnapshot,
    richDescription,
    plainDescription: catalogPlainTextSummary(richDescription),
    sourceHash: sha256Canonical({ ...sourceSnapshot, richDescription }),
    capacity: {
      limit: plan.capacity_limit,
      activeUsers: plan.active_users,
      remaining: plan.remaining,
      sellable: plan.show && plan.sell && (plan.remaining == null || plan.remaining > 0),
    },
    sourceSnapshot,
  }
}

let catalogClientOverrides: FakaBridgeClientOptions | undefined

/** Test-only seam; never accepts credentials from an HTTP request. */
export function __setExternalCatalogClientOverridesForTests(overrides?: FakaBridgeClientOptions): void {
  catalogClientOverrides = overrides
}

export async function fetchNormalizedFakaSource(planId: number): Promise<NormalizedFakaSource> {
  const response = await callFakaPlanCatalog(catalogClientOverrides)
  if (!response.ok || !response.body || response.body.success !== true) {
    throw new HttpError(503, 'BAD_REQUEST', '暂时无法读取 Xboard 套餐目录')
  }
  const plan = response.body.plans.find(item => item.plan_id === planId)
  if (!plan) throw badRequest(`Xboard 不存在 plan_id=${planId}`)
  return normalizeFakaSource(plan)
}
