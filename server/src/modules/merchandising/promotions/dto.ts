// T-MERCH-BE-003 — Promotion DTO allowlist (SPEC-MERCH-001 §7.5/§11,
// CHK-PROMO-013, CHK-SEC-001/002, MERCH-015, REQ-MERCH-NF-004).
//
// Pure mappers (no DB): every merchant/admin DTO is built ONLY from explicit
// fields. Idempotency key/hash, point-log IDs, charged/refunded amounts and
// adjustment fields are NEVER projected (they are billing/internal; even the
// admin view excludes key/hash per CHK-PROMO-013 "DTO/log/metric 不泄露
// key/hash").
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
  // T-MERCH-BE-004：billing 汇总（admin 可见；merchant DTO 不投影）。
  // 绝非 key/hash / point-log ID / 余额历史。
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

/** Merchant-facing campaign DTO：不含 review/internal/billing 字段。 */
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
  createdAt: string
  updatedAt: string
}

/** Admin-facing campaign DTO：review 字段仅 admin 可见；key/hash/pointLog/billing 永不返回。 */
export interface AdminCampaignDto extends MerchantCampaignDto {
  reviewedByUserId: number | null
  reviewedAt: string | null
  reviewReason: string | null
  cancelledByUserId: number | null
  cancellationReason: string | null
  // T-MERCH-BE-004：billing 汇总（admin 调整视图需要 charged/refunded 金额，
  // CHK-PROMO-009）；point-log ID、key/hash、余额历史仍永不返回（CHK-PROMO-013）。
  chargedPoints: number
  refundedPoints: number
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
    createdAt: toIso(row.createdAt) as string,
    updatedAt: toIso(row.updatedAt) as string,
  }
}

export function toAdminCampaignDto(row: CampaignRow): AdminCampaignDto {
  return {
    ...toMerchantCampaignDto(row),
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: toIso(row.reviewedAt),
    reviewReason: row.reviewReason,
    cancelledByUserId: row.cancelledByUserId,
    cancellationReason: row.cancellationReason,
    chargedPoints: row.chargedPoints,
    refundedPoints: row.refundedPoints,
  }
}
