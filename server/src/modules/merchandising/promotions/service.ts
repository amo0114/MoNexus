// T-MERCH-BE-003 — Promotion package/campaign service (SPEC-MERCH-001 §5.3/§5.4,
// §7.1/§7.2/§11, D-MERCH-09/10/12/13, AC-MERCH-009/012/013, CHK-PROMO-001/002/
// 003/006/010/013, CHK-SEC-001/002/004).
//
// Scope: package CRUD (code immutable) + campaign request/review/cancel
// NON-BILLING state machine. Billing (approve charge, retry-payment, refund/
// adjustment, scheduled→active→expired lifecycle) is T-MERCH-BE-004 and lives
// in `billing.ts` — this file never decrements a balance or creates a PointLog.
//
// Frozen semantics enforced here:
//   - price/placement/duration 只取服务端 active 套餐快照，客户端不可覆盖
//     （CHK-PROMO-001）；
//   - pending_review 不扣款（CHK-PROMO-003）；
//   - create 强制 Idempotency-Key（§11）：merchant-scoped key + canonical
//     payload hash；同 key/同 hash 重放返回既有 Campaign（replayed=true），
//     同 key/异 hash → 409 IDEMPOTENCY_KEY_REUSED；DB unique 冲突后读既有行
//     比较 hash，绝不把约束名返回客户端（CHK-PROMO-013 / CHK-SEC-004）；
//   - 跨 merchant 可复用同 key（key scope = merchant）；
//   - 状态转换用 CAS（where status 条件），失败不吞掉（CHK-PROMO-003）；
//   - placement collision 预检（D-MERCH-12）：同 product+placement 已有
//     scheduled/active/paused 时拒绝新建；
//   - 商家只能操作自己的 Campaign/Product（CHK-SEC-002）；
//   - admin mutation 写 AdminLog（CHK-SEC-003），但 detail 不含 key/hash。
//
// SECURITY: this module never logs or returns requestIdempotencyKey /
// requestPayloadHash.

import { Prisma } from '@prisma/client'
import type { CampaignStatus, SponsoredPlacement } from '../constants.js'
import { CAMPAIGN_STATUS, PACKAGE_STATUS } from '../constants.js'
import { notFound, HttpError } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { logger } from '../../../lib/logger.js'
import { PROMOTION_ERROR_CODES, OCCUPIED_PLACEMENT_STATUSES } from './constants.js'
import { canonicalizeCampaignCreate, validateIdempotencyKey } from './idempotency.js'
import type { CreatePackageInput, UpdatePackageInput, CreateCampaignInput, ListCampaignsQuery } from './schema.js'
import {
  toAdminCampaignDto,
  toAdminPackageDto,
  toMerchantCampaignDto,
  toMerchantPackageDto,
  type AdminCampaignDto,
  type AdminPackageDto,
  type CampaignRow,
  type MerchantCampaignDto,
  type MerchantPackageDto,
  type PackageRow,
} from './dto.js'
import { recordCampaignRequest, recordCampaignTransition, recordPackageOutcome } from './metrics.js'
import { summarizeAdminAuditReason } from '../audit.js'

type Db = typeof prisma | Prisma.TransactionClient

const P2002 = 'P2002'

function isCampaignKeyUniqueViolation(err: unknown): boolean {
  const target = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta?.target : undefined
  return (
    err instanceof Prisma.PrismaClientKnownRequestError
    && err.code === P2002
    && (
      /PromotionCampaign_merchantId_requestIdempotencyKey_key/.test(String(target ?? ''))
      || (Array.isArray(target)
        && target.includes('merchantId')
        && target.includes('requestIdempotencyKey'))
    )
  )
}

function isPackageCodeUniqueViolation(err: unknown): boolean {
  const target = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta?.target : undefined
  return (
    err instanceof Prisma.PrismaClientKnownRequestError
    && err.code === P2002
    && (
      /PromotionPackage_code_key/.test(String(target ?? ''))
      || (Array.isArray(target) && target.includes('code'))
    )
  )
}

function keyReusedError(): HttpError {
  return new HttpError(409, PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REUSED as never, '该幂等键已用于内容不同的请求，请确认结果后重新发起')
}

/** 解析商家身份（role 已由 requireMerchant 保证）；跨 merchant 隔离的锚点。 */
export async function resolveMerchantId(userId: number, db: Db = prisma): Promise<number> {
  const merchant = await db.merchant.findUnique({
    where: { userId },
    select: { id: true, status: true },
  })
  if (!merchant || merchant.status !== 'active') {
    throw notFound('商家账户不存在')
  }
  return merchant.id
}

const packageRowSelect = {
  id: true,
  code: true,
  label: true,
  placement: true,
  durationDays: true,
  pricePoints: true,
  description: true,
  sortOrder: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const

const campaignRowSelect = {
  id: true,
  merchantId: true,
  productId: true,
  packageId: true,
  packageCodeSnapshot: true,
  placementSnapshot: true,
  durationDaysSnapshot: true,
  pricePointsSnapshot: true,
  status: true,
  requestedStartAt: true,
  startsAt: true,
  endsAt: true,
  reviewedByUserId: true,
  reviewedAt: true,
  reviewReason: true,
  cancelledByUserId: true,
  cancellationReason: true,
  // T-MERCH-BE-004：billing 汇总（admin list 需展示 charged/refunded，
  // CHK-PROMO-009）；DTO allowlist 控制是否投影。
  chargedPoints: true,
  refundedPoints: true,
  // Selected only for service-side replay comparison. DTO mappers are
  // explicit allowlists and never project this internal value.
  requestPayloadHash: true,
  createdAt: true,
  updatedAt: true,
} as const

type CampaignServiceRow = CampaignRow & { requestPayloadHash: string }

// ---------------------------------------------------------------------------
// PromotionPackage — admin CRUD（code immutable）
// ---------------------------------------------------------------------------

/** merchant 可见：只 active 套餐，按 sortOrder 稳定排序（§7.2）。 */
export async function listMerchantPackages(db: Db = prisma): Promise<MerchantPackageDto[]> {
  const rows = await db.promotionPackage.findMany({
    where: { status: PACKAGE_STATUS.ACTIVE },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: packageRowSelect,
  })
  return rows.map(r => toMerchantPackageDto(r as unknown as PackageRow))
}

/** admin 可见：全量套餐（可含 inactive），按 sortOrder 稳定排序。 */
export async function listAdminPackages(
  options: { includeInactive?: boolean } = {},
  db: Db = prisma,
): Promise<AdminPackageDto[]> {
  const rows = await db.promotionPackage.findMany({
    where: options.includeInactive ? {} : { status: PACKAGE_STATUS.ACTIVE },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: packageRowSelect,
  })
  return rows.map(r => toAdminPackageDto(r as unknown as PackageRow))
}

async function assertAdmin(userId: number, db: Db = prisma): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } })
  if (!user || user.role !== 'admin') {
    throw new HttpError(403, 'FORBIDDEN', '需要管理员权限')
  }
}

/**
 * 创建套餐：code 创建后 immutable（D-MERCH-09 snapshot 契约）。code 重复 →
 * 409 PACKAGE_CODE_TAKEN（不泄露约束名）。写 AdminLog。
 */
export async function createPackage(
  adminUserId: number,
  input: CreatePackageInput,
  db: Db = prisma,
): Promise<AdminPackageDto> {
  await assertAdmin(adminUserId, db)
  let row: PackageRow
  try {
    row = (await db.promotionPackage.create({
      data: {
        code: input.code,
        label: input.label,
        placement: input.placement,
        durationDays: input.durationDays,
        pricePoints: input.pricePoints,
        description: input.description,
        sortOrder: input.sortOrder,
        status: PACKAGE_STATUS.ACTIVE,
        createdByUserId: adminUserId,
        updatedByUserId: adminUserId,
      },
      select: packageRowSelect,
    })) as unknown as PackageRow
  } catch (err) {
    if (isPackageCodeUniqueViolation(err)) {
      throw new HttpError(409, PROMOTION_ERROR_CODES.PACKAGE_CODE_TAKEN as never, '套餐编码已存在')
    }
    throw err
  }
  await writeAdminLog(db, adminUserId, '创建推广套餐', 'promotion_package', row.id, `code=${row.code}`).catch(err => {
    logger.error({ err }, 'failed to write package create admin log')
  })
  recordPackageOutcome('created')
  return toAdminPackageDto(row)
}

/**
 * 更新套餐：code 不可改（schema 已 omit；此处防御性拒绝）。写 AdminLog。
 */
export async function updatePackage(
  adminUserId: number,
  packageId: number,
  input: UpdatePackageInput,
  db: Db = prisma,
): Promise<AdminPackageDto> {
  await assertAdmin(adminUserId, db)
  const existing = await db.promotionPackage.findUnique({ where: { id: packageId }, select: { id: true } })
  if (!existing) throw notFound('推广套餐不存在')
  const row = (await db.promotionPackage.update({
    where: { id: packageId },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.placement !== undefined ? { placement: input.placement } : {}),
      ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
      ...(input.pricePoints !== undefined ? { pricePoints: input.pricePoints } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedByUserId: adminUserId,
    },
    select: packageRowSelect,
  })) as unknown as PackageRow
  await writeAdminLog(db, adminUserId, '更新推广套餐', 'promotion_package', row.id, `code=${row.code}`).catch(err => {
    logger.error({ err }, 'failed to write package update admin log')
  })
  recordPackageOutcome('updated')
  return toAdminPackageDto(row)
}

// ---------------------------------------------------------------------------
// PromotionCampaign — merchant request / list / cancel；admin list / reject
// ---------------------------------------------------------------------------

async function writeAdminLog(
  db: Db,
  adminUserId: number,
  action: string,
  targetType: string,
  targetId: number,
  detail: string,
): Promise<void> {
  await db.adminLog.create({ data: { adminUserId, action, targetType, targetId, detail } })
}

/** 请求目标商品必须属于该商家且 active（§7.2 / CHK-PROMO-002）。 */
async function loadEligibleProduct(merchantId: number, productId: number, db: Db = prisma) {
  const product = await db.product.findFirst({
    where: { id: productId, merchantId },
    select: { id: true, status: true },
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active') {
    throw new HttpError(409, PROMOTION_ERROR_CODES.PRODUCT_NOT_ELIGIBLE as never, '只有上架商品可以申请推广')
  }
  return product
}

async function loadActivePackage(packageId: number, db: Db = prisma): Promise<PackageRow> {
  const row = (await db.promotionPackage.findUnique({
    where: { id: packageId },
    select: packageRowSelect,
  })) as unknown as PackageRow | null
  if (!row) throw notFound('推广套餐不存在')
  if (row.status !== PACKAGE_STATUS.ACTIVE) {
    throw new HttpError(409, PROMOTION_ERROR_CODES.PACKAGE_NOT_ACTIVE as never, '该推广套餐已停售')
  }
  return row
}

/**
 * placement collision 预检（D-MERCH-12）：同 (productId, placement) 已有
 * scheduled/active/paused campaign → 该请求永远不会被批准，直接 409
 * PLACEMENT_OCCUPIED。DB partial unique 是批准时（BE-004）的最终裁决；
 * 此处只是创建前的友好预检。多个 pending_review 允许共存（不占位）。
 */
export async function assertPlacementFree(
  productId: number,
  placement: SponsoredPlacement,
  db: Db = prisma,
): Promise<void> {
  const occupier = await db.promotionCampaign.findFirst({
    where: { productId, placementSnapshot: placement, status: { in: OCCUPIED_PLACEMENT_STATUSES as string[] } },
    select: { id: true },
  })
  if (occupier) {
    throw new HttpError(409, PROMOTION_ERROR_CODES.PLACEMENT_OCCUPIED as never, '该商品在所选展位已有进行中的推广活动')
  }
}

export type CampaignCreateResult =
  | { kind: 'created'; campaign: MerchantCampaignDto }
  | { kind: 'replayed'; campaign: MerchantCampaignDto }

/**
 * 商家申请推广（§7.2 / §11）。强制 Idempotency-Key；价格/placement/duration
 * 只取服务端 active 套餐快照；pending_review 不扣款。
 *
 * 流程：
 *   1. 校验 key（400 IDEMPOTENCY_KEY_REQUIRED / INVALID）；
 *   2. canonicalize payload（strict schema 已拒未知字段）→ hash；
 *   3. 先查 (merchantId, key) 既有行：同 hash → 重放返回既有 Campaign，
 *      异 hash → 409 IDEMPOTENCY_KEY_REUSED（重放不依赖商品/套餐当前状态）；
 *   4. 无既有行才校验商品归属/active、套餐 active、placement 预检；
 *   5. create pending_review；P2002（并发首创）→ 重读既有行比较 hash。
 */
export async function createCampaign(
  input: {
    merchantId: number
    campaignInput: CreateCampaignInput
    idempotencyKeyRaw: string | undefined | null
  },
  db: Db = prisma,
): Promise<CampaignCreateResult> {
  const key = validateIdempotencyKey(input.idempotencyKeyRaw)

  const requestedStartAtUtcOrNull = input.campaignInput.requestedStartAt
  const requestPayloadHash = canonicalizeCampaignCreate({
    productId: input.campaignInput.productId,
    packageId: input.campaignInput.packageId,
    requestedStartAtUtcOrNull,
  })

  const existing = await db.promotionCampaign.findUnique({
    where: {
      merchantId_requestIdempotencyKey: {
        merchantId: input.merchantId,
        requestIdempotencyKey: key,
      },
    },
    select: campaignRowSelect,
  })
  if (existing) {
    if (existing.requestPayloadHash !== requestPayloadHash) {
      recordCampaignRequest('conflict')
      throw keyReusedError()
    }
    recordCampaignRequest('replayed')
    return { kind: 'replayed', campaign: toMerchantCampaignDto(existing as unknown as CampaignRow) }
  }

  const [product, pkg] = await Promise.all([
    loadEligibleProduct(input.merchantId, input.campaignInput.productId, db),
    loadActivePackage(input.campaignInput.packageId, db),
  ])
  await assertPlacementFree(product.id, pkg.placement as SponsoredPlacement, db)

  let createdRow: CampaignServiceRow
  try {
    createdRow = (await db.promotionCampaign.create({
      data: {
        merchantId: input.merchantId,
        productId: product.id,
        packageId: pkg.id,
        packageCodeSnapshot: pkg.code,
        placementSnapshot: pkg.placement,
        durationDaysSnapshot: pkg.durationDays,
        pricePointsSnapshot: pkg.pricePoints,
        requestIdempotencyKey: key,
        requestPayloadHash,
        status: CAMPAIGN_STATUS.PENDING_REVIEW,
        requestedStartAt: requestedStartAtUtcOrNull === null ? null : new Date(requestedStartAtUtcOrNull),
      },
      select: campaignRowSelect,
    })) as unknown as CampaignServiceRow
  } catch (err) {
    if (isCampaignKeyUniqueViolation(err)) {
      // 并发首创：另一请求刚用同 key 创建。重读既有行比较 hash，
      // 绝不把约束名返回客户端（CHK-SEC-004）。
      const raced = await db.promotionCampaign.findUnique({
        where: {
          merchantId_requestIdempotencyKey: {
            merchantId: input.merchantId,
            requestIdempotencyKey: key,
          },
        },
        select: campaignRowSelect,
      })
      if (!raced) throw err
      if (raced.requestPayloadHash !== requestPayloadHash) {
        recordCampaignRequest('conflict')
        throw keyReusedError()
      }
      recordCampaignRequest('replayed')
      return { kind: 'replayed', campaign: toMerchantCampaignDto(raced as unknown as CampaignRow) }
    }
    throw err
  }
  recordCampaignRequest('created')
  return { kind: 'created', campaign: toMerchantCampaignDto(createdRow) }
}

/** 商家查看自己的 Campaign（分页 + 可选 status 过滤）。 */
export async function listMerchantCampaigns(
  merchantId: number,
  query: ListCampaignsQuery = {},
  db: Db = prisma,
): Promise<{ campaigns: MerchantCampaignDto[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20))
  const where = {
    merchantId,
    ...(query.status ? { status: query.status as CampaignStatus } : {}),
  }
  const [rows, total] = await Promise.all([
    db.promotionCampaign.findMany({
      where,
      orderBy: [{ id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: campaignRowSelect,
    }),
    db.promotionCampaign.count({ where }),
  ])
  return {
    campaigns: rows.map(r => toMerchantCampaignDto(r as unknown as CampaignRow)),
    total,
    page,
    pageSize,
  }
}

/** admin 查看全部 Campaign（review 字段仅 admin DTO 返回；无 key/hash/billing 字段）。 */
export async function listAdminCampaigns(
  query: ListCampaignsQuery = {},
  db: Db = prisma,
): Promise<{ campaigns: AdminCampaignDto[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20))
  const where = {
    ...(query.status ? { status: query.status as CampaignStatus } : {}),
  }
  const [rows, total] = await Promise.all([
    db.promotionCampaign.findMany({
      where,
      orderBy: [{ id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: campaignRowSelect,
    }),
    db.promotionCampaign.count({ where }),
  ])
  return {
    campaigns: rows.map(r => toAdminCampaignDto(r as unknown as CampaignRow)),
    total,
    page,
    pageSize,
  }
}

/**
 * 商家取消自己的 pending_review Campaign（§7.1 / CHK-PROMO-003）：未扣款，
 * 状态 CAS pending_review → cancelled；重复取消幂等返回既有 cancelled。
 */
export async function cancelMerchantCampaign(
  merchantId: number,
  userId: number,
  campaignId: number,
  input: { reason?: string },
  db: Db = prisma,
): Promise<MerchantCampaignDto> {
  const existing = await db.promotionCampaign.findFirst({
    where: { id: campaignId, merchantId },
    select: campaignRowSelect,
  })
  if (!existing) throw notFound('推广活动不存在')

  const updated = await db.promotionCampaign.updateMany({
    where: { id: campaignId, merchantId, status: CAMPAIGN_STATUS.PENDING_REVIEW },
    data: {
      status: CAMPAIGN_STATUS.CANCELLED,
      cancelledByUserId: userId,
      cancellationReason: input.reason ?? '商家取消申请',
    },
  })
  if (updated.count === 0) {
    // 已是终态：重复取消幂等；否则为不允许的转换。
    if (existing.status === CAMPAIGN_STATUS.CANCELLED) {
      return toMerchantCampaignDto(existing as unknown as CampaignRow)
    }
    throw new HttpError(409, PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID as never, '当前状态不允许取消')
  }
  recordCampaignTransition(existing.status as CampaignStatus, CAMPAIGN_STATUS.CANCELLED)
  const row = await db.promotionCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: campaignRowSelect,
  })
  return toMerchantCampaignDto(row as unknown as CampaignRow)
}

/**
 * admin 拒绝 pending_review Campaign（§7.1 / CHK-PROMO-003）：未扣款；
 * 状态 CAS pending_review → rejected，写 review 字段 + AdminLog。
 */
export async function rejectCampaign(
  adminUserId: number,
  campaignId: number,
  input: { reason: string },
  db: Db = prisma,
): Promise<AdminCampaignDto> {
  await assertAdmin(adminUserId, db)
  const existing = await db.promotionCampaign.findUnique({
    where: { id: campaignId },
    select: campaignRowSelect,
  })
  if (!existing) throw notFound('推广活动不存在')

  const reviewedAt = new Date()
  const updated = await db.promotionCampaign.updateMany({
    where: { id: campaignId, status: CAMPAIGN_STATUS.PENDING_REVIEW },
    data: {
      status: CAMPAIGN_STATUS.REJECTED,
      reviewedByUserId: adminUserId,
      reviewedAt,
      reviewReason: input.reason,
    },
  })
  if (updated.count === 0) {
    throw new HttpError(409, PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID as never, '当前状态不允许拒绝')
  }
  await writeAdminLog(db, adminUserId, '拒绝推广活动', 'promotion_campaign', campaignId, summarizeAdminAuditReason(input.reason)).catch(err => {
    logger.error({ err }, 'failed to write campaign reject admin log')
  })
  recordCampaignTransition(existing.status as CampaignStatus, CAMPAIGN_STATUS.REJECTED)
  const row = await db.promotionCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: campaignRowSelect,
  })
  return toAdminCampaignDto(row as unknown as CampaignRow)
}
