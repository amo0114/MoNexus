// T-MERCH-BE-004 — Public sponsored shelf service
// (SPEC-MERCH-001 §7.5, D-MERCH-14, AC-MERCH-016/017, CHK-PUBLIC-001/002/003/004,
// CHK-SEC-001, REQ-MERCH-NF-002/005).
//
// Owned by this card. Contract:
//   - 只返回 active campaign + active Product + active Merchant；
//   - limit 1..12（schema 已校验；service 防御性 clamp）；
//   - `hash(campaignId, placement, floor(serverTime/10min))` 确定性轮换
//     （同一 bucket 内稳定、公平但不承诺次数，D-MERCH-14）；
//   - 每项强制 `{ disclosure: { code:'sponsored', label:'推广' } }`（文字披露，
//     与卡片同可见层级，CHK-PUBLIC-003）；
//   - 缓存最大 60s，campaign/status/product 变化由 billing/lifecycle 主动失效
//     （invalidateSponsoredCache）；
//   - 不返回 chargedPoints/审核人/内部 reason/余额/point log（CHK-SEC-001）；
//   - sponsored 永不进入 organic cursor/score/hot（本 endpoint 独立，CHK-PUBLIC-004）；
//   - 无 DB 每次请求写；metrics labels 有界（placement 枚举）。
//
// SECURITY：不 log/返回任何内部 key/hash、余额或 PointLog。

import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { CAMPAIGN_STATUS, SPONSORED_DISCLOSURE, type SponsoredPlacement } from '../constants.js'
import type { SponsoredShelfItem } from '../contracts.js'
import { prisma } from '../../../lib/prisma.js'
import { recordSponsoredItems } from './metrics.js'

type Db = typeof prisma | Prisma.TransactionClient

/** 10 分钟轮换 bucket（spec §7.5 `floor(serverTime/10min)`）。 */
export const SPONSORED_ROTATION_BUCKET_MS = 10 * 60 * 1000
/** 缓存最大 60s（spec §7.5）。 */
export const SPONSORED_CACHE_TTL_MS = 60_000
/** limit 防御性边界（schema 已限 1..12）。 */
export const SPONSORED_LIMIT_MIN = 1
export const SPONSORED_LIMIT_MAX = 12
export const SPONSORED_DEFAULT_LIMIT = 6

/**
 * 轮换 bucket：`floor(serverTime / 10min)`。纯函数（无 DB），
 * serverTime 由调用方注入（默认 Date.now()），测试可冻结。
 */
export function computeSponsoredBucket(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('sponsored rotation bucket requires a non-negative finite nowMs')
  }
  return Math.floor(nowMs / SPONSORED_ROTATION_BUCKET_MS)
}

/**
 * 确定性轮换 key：`sha256("${campaignId}|${placement}|${bucket}")`（spec §7.5）。
 * 纯函数；同输入恒同输出，排序稳定（无平局）。不做任何业务字段/余额参与。
 */
export function computeRotationRank(campaignId: number, placement: string, bucket: number): string {
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    throw new Error('sponsored rotation rank requires a positive integer campaignId')
  }
  if (!Number.isFinite(bucket)) {
    throw new Error('sponsored rotation rank requires a finite bucket')
  }
  return createHash('sha256').update(`${campaignId}|${placement}|${bucket}`, 'utf8').digest('hex')
}

export function normalizeSponsoredLimit(limit: number | undefined | null): number {
  const value = limit === undefined || limit === null ? SPONSORED_DEFAULT_LIMIT : Math.floor(limit)
  if (!Number.isFinite(value)) return SPONSORED_DEFAULT_LIMIT
  return Math.min(SPONSORED_LIMIT_MAX, Math.max(SPONSORED_LIMIT_MIN, value))
}

export interface SponsoredQueryInput {
  placement?: SponsoredPlacement | undefined
  categoryCode?: string | undefined
  limit?: number | undefined
}

/** 模块级 60s 缓存：key = placement|categoryCode|limit|bucket。无 DB 每请求写。 */
const cache = new Map<string, { expiresAt: number; items: SponsoredShelfItem[] }>()

/** 主动失效（billing/lifecycle 在 campaign 状态变化后调用；CHK-PUBLIC-001）。 */
export function invalidateSponsoredCache(): void {
  cache.clear()
}

export function computeSponsoredCacheKey(
  placement: SponsoredPlacement | null,
  categoryCode: string | null,
  limit: number,
  bucket: number,
): string {
  return `${placement ?? '*'}|${categoryCode ?? '*'}|${limit}|${bucket}`
}

/**
 * 公开展位查询（spec §7.5）。
 *
 * 查询条件：campaign.status=active；placement（可选）；Product.status=active（可选
 * categoryCode 过滤商品的 category.code）；Merchant.status=active。返回后按 bucket
 * 轮换 key 排序取 limit。命中 60s 缓存直接返回。
 */
export async function listSponsoredItems(
  input: SponsoredQueryInput = {},
  db: Db = prisma,
  nowMs = Date.now(),
): Promise<SponsoredShelfItem[]> {
  const placement = input.placement ?? null
  const categoryCode = typeof input.categoryCode === 'string' && input.categoryCode.trim().length > 0
    ? input.categoryCode.trim()
    : null
  const limit = normalizeSponsoredLimit(input.limit)
  const bucket = computeSponsoredBucket(nowMs)

  const cacheKey = computeSponsoredCacheKey(placement, categoryCode, limit, bucket)
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > nowMs) {
    return cached.items
  }

  const where: Prisma.PromotionCampaignWhereInput = {
    status: CAMPAIGN_STATUS.ACTIVE,
    ...(placement ? { placementSnapshot: placement } : {}),
    product: {
      status: 'active',
      ...(categoryCode ? { category: { code: categoryCode } } : {}),
    },
    merchant: { status: 'active' },
  }

  const campaigns = await db.promotionCampaign.findMany({
    where,
    select: { id: true, placementSnapshot: true, productId: true },
  })

  const ranked = campaigns
    .map(campaign => ({
      campaign,
      key: computeRotationRank(campaign.id, campaign.placementSnapshot, bucket),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const items: SponsoredShelfItem[] = ranked.slice(0, limit).map(({ campaign }) => ({
    productId: campaign.productId,
    disclosure: { code: SPONSORED_DISCLOSURE.code, label: SPONSORED_DISCLOSURE.label },
  }))

  cache.set(cacheKey, { expiresAt: nowMs + SPONSORED_CACHE_TTL_MS, items })
  recordSponsoredItems(placement ?? 'all', items.length)
  return items
}
