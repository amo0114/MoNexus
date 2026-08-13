// T-MERCH-BE-003 — Promotion DTO allowlist (SPEC-MERCH-001 §7.5/§11,
// CHK-PROMO-013, CHK-SEC-001/002, MERCH-015, REQ-MERCH-NF-004).
//
// Pure mappers (no DB): every merchant/admin DTO is built ONLY from explicit
// fields. Idempotency key/hash, point-log IDs and adjustment fields are NEVER
// projected (they are billing/internal; even the admin view excludes key/hash
// per CHK-PROMO-013 "DTO/log/metric 不泄露 key/hash").
//
// The charged/refunded point TOTALS are the merchant's OWN ledger (SPEC-MERCH-001
// §5.4, frozen FE PromotionCampaignDTO) and ARE projected into BOTH the merchant
// and admin DTOs — the merchant UI renders 已扣/已退回 from them (promotionCopy).
// Only the underlying point-log IDs, key/hash and adjustment internals stay internal.
//
// The mapper signatures take plain row shapes so they are unit-testable
// without Prisma and so an accidental future widening is caught at compile
// time (extra fields simply are not listed).

import type { CampaignStatus, SponsoredPlacement } from '../constants.js'

/** DB row projection used by the mappers (explicit pick of allowed columns). */
export interface PackageRow {
  id: number
  code: string
  label: string
  placement: string
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
  status: string
  createdAt: Date
  updatedAt: Date
}

export interface CampaignRow {
  id: number
  merchantId: number
  productId: number
  packageId: number
  packageCodeSnapshot: string
  placementSnapshot: string
  durationDaysSnapshot: number
  pricePointsSnapshot: number
  status: CampaignStatus
  requestedStartAt: Date | null
  startsAt: Date | null
  endsAt: Date | null
  reviewedByUserId: number | null
  reviewedAt: Date | null
  reviewReason: string | null
  cancelledByUserId: number | null
  cancellationReason: string | null
  // T-MERCH-BE-004：billing 汇总（merchant 与 admin DTO 均投影；
  // 商家自己账本的已扣/已退积分，绝非 key/hash / point-log ID / 余额历史）。
  chargedPoints: number
  refundedPoints: number
  createdAt: Date
  updatedAt: Date
}

/** Merchant-facing package DTO（只 active 套餐，无任何内部字段）。 */
export interface MerchantPackageDto {
  id: number
  code: string
  label: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
}

/** Admin-facing package DTO（含 status / 审计时间，仍无内部 key/hash）。 */
export interface AdminPackageDto extends MerchantPackageDto {
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

/** Merchant-facing campaign DTO：含商家自己账本的已扣/已退积分；
 * 仍不含 review/internal 字段（reviewReason/审核人/取消人仅 admin 可见）、
 * 不含 key/hash、point-log ID、adjustment 内部字段（MERCH-015 / CHK-SEC-001）。 */
export interface MerchantCampaignDto {
  id: number
  merchantId: number
  productId: number
  packageId: number
  packageCodeSnapshot: string
  placementSnapshot: SponsoredPlacement
  durationDaysSnapshot: number
  pricePointsSnapshot: number
  status: CampaignStatus
  requestedStartAt: string | null
  startsAt: string | null
  endsAt: string | null
  // 商家自己账本：扣费金额与已退金额（SPEC-MERCH-001 §5.4，冻结 FE 契约
  // PromotionCampaignDTO）。未扣款状态为 0；绝不包含 point-log ID / key/hash。
  chargedPoints: number
  refundedPoints: number
  createdAt: string
  updatedAt: string
}

/** Admin-facing campaign DTO：review 字段仅 admin 可见；key/hash/pointLog 永不返回。
 * chargedPoints/refundedPoints 继承自 MerchantCampaignDto（商家账本汇总，
 * CHK-PROMO-009 调整视图需要）；point-log ID、key/hash、余额历史仍永不返回（CHK-PROMO-013）。 */
export interface AdminCampaignDto extends MerchantCampaignDto {
  reviewedByUserId: number | null
  reviewedAt: string | null
  reviewReason: string | null
  cancelledByUserId: number | null
  cancellationReason: string | null
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function toPlacement(value: string): SponsoredPlacement {
  // placement 由 DB CHECK 约束限定为两个冻结值；映射时做防御性收窄。
  if (value === 'store_home_sponsored' || value === 'category_sponsored') {
    return value
  }
  throw new Error(`unexpected promotion placement: ${value}`)
}

export function toMerchantPackageDto(row: PackageRow): MerchantPackageDto {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    placement: toPlacement(row.placement),
    durationDays: row.durationDays,
    pricePoints: row.pricePoints,
    description: row.description,
    sortOrder: row.sortOrder,
  }
}

export function toAdminPackageDto(row: PackageRow): AdminPackageDto {
  return {
    ...toMerchantPackageDto(row),
    status: row.status === 'active' ? 'active' : 'inactive',
    createdAt: toIso(row.createdAt) as string,
    updatedAt: toIso(row.updatedAt) as string,
  }
}

export function toMerchantCampaignDto(row: CampaignRow): MerchantCampaignDto {
  return {
    id: row.id,
    merchantId: row.merchantId,
    productId: row.productId,
    packageId: row.packageId,
    packageCodeSnapshot: row.packageCodeSnapshot,
    placementSnapshot: toPlacement(row.placementSnapshot),
    durationDaysSnapshot: row.durationDaysSnapshot,
    pricePointsSnapshot: row.pricePointsSnapshot,
    status: row.status,
    requestedStartAt: toIso(row.requestedStartAt),
    startsAt: toIso(row.startsAt),
    endsAt: toIso(row.endsAt),
    // 商家自己账本汇总（§5.4 冻结契约）；无 point-log ID / key/hash。
    chargedPoints: row.chargedPoints,
    refundedPoints: row.refundedPoints,
    createdAt: toIso(row.createdAt) as string,
    updatedAt: toIso(row.updatedAt) as string,
  }
}

export function toAdminCampaignDto(row: CampaignRow): AdminCampaignDto {
  // 显式逐字段构建，保持原 admin 序列化 key 顺序 byte-identical
  // （spread 会把 merchant 新加的 chargedPoints/refundedPoints 提前到 createdAt
  // 之前；这里必须让它们位于 cancellationReason 之后，与改动前完全一致）。
  return {
    id: row.id,
    merchantId: row.merchantId,
    productId: row.productId,
    packageId: row.packageId,
    packageCodeSnapshot: row.packageCodeSnapshot,
    placementSnapshot: toPlacement(row.placementSnapshot),
    durationDaysSnapshot: row.durationDaysSnapshot,
    pricePointsSnapshot: row.pricePointsSnapshot,
    status: row.status,
    requestedStartAt: toIso(row.requestedStartAt),
    startsAt: toIso(row.startsAt),
    endsAt: toIso(row.endsAt),
    createdAt: toIso(row.createdAt) as string,
    updatedAt: toIso(row.updatedAt) as string,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: toIso(row.reviewedAt),
    reviewReason: row.reviewReason,
    cancelledByUserId: row.cancelledByUserId,
    cancellationReason: row.cancellationReason,
    chargedPoints: row.chargedPoints,
    refundedPoints: row.refundedPoints,
  }
}
