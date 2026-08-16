// T-MERCH-BE-004 — Promotion billing service
// (SPEC-MERCH-001 §5.4/§7.1/§7.3/§7.4/§11, D-MERCH-10/11/12/13,
// AC-MERCH-010/011/012/014/015/027, CHK-PROMO-004/005/006/008/009/011/013,
// CHK-SEC-003/004).
//
// Owned by this card. Scope:
//   - admin approve / merchant retry 的原子扣款（balance+PointLog+campaign+AdminLog
//     同一 transaction，MERCH-008）；
//   - 余额不足 → payment_failed（零 PointLog、零部分扣款）；
//   - placement partial unique 冲突 → 稳定 409 PLACEMENT_OCCUPIED（不泄露约束名）；
//   - scheduled 开跑前平台 cancel → 全额自动退（refundPointLogId 幂等，不二次退）；
//   - active/paused pause/resume、cancel（cancel 走一次性显式调整决定）；
//   - active/paused refund-adjustment：强制 §11 Idempotency-Key，campaign-scoped
//     key + canonical hash + 行锁 + `adjustmentDecidedAt IS NULL` CAS，最多一次
//     0..chargedPoints 决定；同 key/同 payload 重放既有决定，同 key/异 payload 或
//     第二个新决定均稳定 409；>0 才写唯一 refund PointLog。
//
// Must Not Touch：Order point debit/refund、Settlement、schema/migration、
// products service/StorePage、真实余额外部系统。Points 只通过 `points.ts`
// （本 lane 最小独占区域）读写。
//
// SECURITY（CHK-PROMO-013 / CHK-SEC-004）：本模块不 log、不返回
// requestIdempotencyKey / requestPayloadHash / adjustmentIdempotencyKey /
// adjustmentPayloadHash；DTO allowlist 是唯一序列化边界。

import { Prisma } from '@prisma/client'
import type { CampaignStatus } from '../constants.js'
import { CAMPAIGN_STATUS, PACKAGE_STATUS } from '../constants.js'
import { notFound, HttpError } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import {
  OCCUPIED_PLACEMENT_STATUSES,
  PROMOTION_ERROR_CODES,
} from './constants.js'
import {
  canonicalizeCampaignAdjustment,
  validateIdempotencyKey,
} from './idempotency.js'
import {
  creditPointsForPromotionRefund,
  dbNow,
  debitPointsForPromotionCharge,
  type Db,
} from './points.js'
import {
  toAdminCampaignDto,
  toMerchantCampaignDto,
  type AdminCampaignDto,
  type CampaignRow,
  type MerchantCampaignDto,
} from './dto.js'
import {
  recordAdjustmentOutcome,
  recordCampaignTransition,
  recordChargeOutcome,
} from './metrics.js'
import { invalidateSponsoredCache } from './publicSponsored.js'

const P2002 = 'P2002'

/** Public billing entry points always need a main Prisma client that can open
 * an interactive transaction. Helpers used inside that transaction keep the
 * narrower `Db`/`TransactionClient` types. */
type TransactionHost = typeof prisma

/** placement partial unique（F0 raw SQL）的精确索引名；冲突映射用。 */
const PLACEMENT_PARTIAL_UNIQUE_INDEX = 'PromotionCampaign_one_placement_per_product'

function isPlacementUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== P2002) return false
  // PostgreSQL partial unique indexes are not represented in Prisma schema.
  // Depending on client/engine version `meta.target` is the raw index name,
  // the indexed column pair, or absent. Within the approve/retry transaction
  // every other unique field is protected by the locked campaign row, so a
  // P2002 here can only be the placement arbiter and must become the stable
  // domain error instead of leaking provider metadata.
  return true
}

function placementOccupiedError(): HttpError {
  return new HttpError(409, PROMOTION_ERROR_CODES.PLACEMENT_OCCUPIED as never, '该商品在所选展位已有进行中的推广活动')
}

function transitionInvalidError(message = '当前状态不允许该操作'): HttpError {
  return new HttpError(409, PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID as never, message)
}

function adjustmentAlreadyDecidedError(): HttpError {
  return new HttpError(409, PROMOTION_ERROR_CODES.CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED as never, '该推广活动已完成退款调整，不能再次调整')
}

function keyReusedError(): HttpError {
  return new HttpError(409, PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REUSED as never, '该幂等键已用于内容不同的请求，请确认结果后重新发起')
}

async function assertAdmin(userId: number, db: Db = prisma): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } })
  if (!user || user.role !== 'admin') {
    throw new HttpError(403, 'FORBIDDEN', '需要管理员权限')
  }
}

async function writeAdminLog(
  db: Db,
  adminUserId: number,
  action: string,
  targetType: string,
  targetId: number,
  detail: string,
): Promise<void> {
  // detail 不包含任何 idempotency key/hash（CHK-SEC-004）。
  await db.adminLog.create({ data: { adminUserId, action, targetType, targetId, detail } })
}

/** billing 侧行锁读取的行形状（显式列，不把 request key/hash 带进代码路径）。 */
export interface CampaignLockedRow {
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
  chargePointLogId: number | null
  chargedPoints: number
  refundedPoints: number
  refundPointLogId: number | null
  adjustmentDecidedAt: Date | null
  adjustmentByUserId: number | null
  adjustmentReason: string | null
  adjustmentIdempotencyKey: string | null
  adjustmentPayloadHash: string | null
  cancelledByUserId: number | null
  cancellationReason: string | null
  reviewedByUserId: number | null
  reviewedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const CAMPAIGN_LOCK_COLUMNS = `
  "id","merchantId","productId","packageId","packageCodeSnapshot","placementSnapshot",
  "durationDaysSnapshot","pricePointsSnapshot","status","requestedStartAt","startsAt","endsAt",
  "chargePointLogId","chargedPoints","refundedPoints","refundPointLogId",
  "adjustmentDecidedAt","adjustmentByUserId","adjustmentReason","adjustmentIdempotencyKey","adjustmentPayloadHash",
  "cancelledByUserId","cancellationReason","reviewedByUserId","reviewedAt","createdAt","updatedAt"
`

/**
 * 行锁：`SELECT ... FOR UPDATE`。所有 billing 转换先在交互式事务内锁住
 * campaign 行，并发 approve/retry/cancel/adjust 因此串行化；DB 约束
 * （chargePointLogId/refundPointLogId UNIQUE、adjustmentDecidedAt CAS、
 * partial unique）是最终兜底。
 */
export async function lockCampaignRow(client: Db, campaignId: number): Promise<CampaignLockedRow | null> {
  const rows = await client.$queryRaw<CampaignLockedRow[]>`
    SELECT ${Prisma.raw(CAMPAIGN_LOCK_COLUMNS)}
    FROM "PromotionCampaign"
    WHERE "id" = ${campaignId}
    FOR UPDATE`
  return rows[0] ?? null
}

/** 读取 billing 相关的 DTO 行（CampaignRow + billing 字段），供 DTO 映射。 */
const billingCampaignSelect = {
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
  chargedPoints: true,
  refundedPoints: true,
  createdAt: true,
  updatedAt: true,
} as const

type BillingRow = CampaignRow & { chargedPoints: number; refundedPoints: number }

async function fetchBillingRow(client: Db, campaignId: number): Promise<BillingRow> {
  const row = await client.promotionCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: billingCampaignSelect,
  })
  return row as unknown as BillingRow
}

/**
 * 排期解析（纯函数）：requestedStartAt 在未来 → scheduled（startsAt=requested），
 * 否则 → active（startsAt=now）；endsAt = startsAt + durationDays（DB 时间锚定）。
 */
export function resolveChargeSchedule(
  campaign: Pick<CampaignLockedRow, 'requestedStartAt' | 'durationDaysSnapshot'>,
  now: Date,
): { status: 'scheduled' | 'active'; startsAt: Date; endsAt: Date } {
  const requested = campaign.requestedStartAt
  const startInFuture = requested !== null && requested.getTime() > now.getTime()
  const startsAt = startInFuture ? requested : now
  const endsAt = new Date(startsAt.getTime() + campaign.durationDaysSnapshot * 24 * 60 * 60 * 1000)
  return { status: startInFuture ? 'scheduled' : 'active', startsAt, endsAt }
}

// ---------------------------------------------------------------------------
// approve / retry — 原子扣款（§7.3）
// ---------------------------------------------------------------------------

export type ApproveCampaignResult =
  | { kind: 'charged'; campaign: AdminCampaignDto }
  | { kind: 'payment_failed'; campaign: AdminCampaignDto }

/** 共享的扣款+状态落地步骤（approve 与 retry 共用同一 billing 路径）。 */
async function applyChargeAndSchedule(
  tx: Prisma.TransactionClient,
  input: {
    campaign: CampaignLockedRow
    merchantUserId: number
    adminUserId?: number // approve 路径写 review 字段；retry 不写
    now: Date
  },
): Promise<ApproveCampaignResult> {
  const { campaign, now } = input
  const price = campaign.pricePointsSnapshot
  const charge = await debitPointsForPromotionCharge(tx, input.merchantUserId, price)
  if (!charge.ok) {
    // 余额不足：不扣、不写 PointLog，CAS pending_review/payment_failed → payment_failed。
    const updated = await tx.promotionCampaign.update({
      where: { id: campaign.id },
      data: {
        status: CAMPAIGN_STATUS.PAYMENT_FAILED,
        ...(input.adminUserId !== undefined ? { reviewedByUserId: input.adminUserId, reviewedAt: now } : {}),
      },
      select: billingCampaignSelect,
    })
    return { kind: 'payment_failed', campaign: toAdminCampaignDto(updated as unknown as BillingRow) }
  }

  const { status: nextStatus, startsAt, endsAt } = resolveChargeSchedule(campaign, now)
  const updated = await tx.promotionCampaign.update({
    where: { id: campaign.id },
    data: {
      status: nextStatus,
      chargePointLogId: charge.pointLogId,
      chargedPoints: price,
      startsAt,
      endsAt,
      ...(input.adminUserId !== undefined ? { reviewedByUserId: input.adminUserId, reviewedAt: now } : {}),
    },
    select: billingCampaignSelect,
  })
  return { kind: 'charged', campaign: toAdminCampaignDto(updated as unknown as BillingRow) }
}

/** 批准前重验（approve 路径）：merchant/product/package active + placement 冲突预检。 */
async function assertApprovable(
  tx: Prisma.TransactionClient,
  campaign: CampaignLockedRow,
  options: { requirePackageActive: boolean },
): Promise<number> {
  const merchant = await tx.merchant.findUnique({
    where: { id: campaign.merchantId },
    select: { id: true, status: true, userId: true },
  })
  if (!merchant) throw notFound('商家不存在')
  if (merchant.status !== 'active') {
    throw new HttpError(409, PROMOTION_ERROR_CODES.MERCHANT_NOT_ELIGIBLE as never, '商家账户状态不允许投放')
  }
  const product = await tx.product.findUnique({
    where: { id: campaign.productId },
    select: { id: true, status: true, merchantId: true },
  })
  if (!product) throw notFound('商品不存在')
  if (product.status !== 'active') {
    throw new HttpError(409, PROMOTION_ERROR_CODES.PRODUCT_NOT_ELIGIBLE as never, '只有上架商品可以投放')
  }
  if (options.requirePackageActive) {
    const pkg = await tx.promotionPackage.findUnique({
      where: { id: campaign.packageId },
      select: { id: true, status: true },
    })
    if (!pkg) throw notFound('推广套餐不存在')
    if (pkg.status !== PACKAGE_STATUS.ACTIVE) {
      throw new HttpError(409, PROMOTION_ERROR_CODES.PACKAGE_NOT_ACTIVE as never, '该推广套餐已停售')
    }
  }
  const occupier = await tx.promotionCampaign.findFirst({
    where: {
      productId: campaign.productId,
      placementSnapshot: campaign.placementSnapshot,
      status: { in: OCCUPIED_PLACEMENT_STATUSES as string[] },
      id: { not: campaign.id },
    },
    select: { id: true },
  })
  if (occupier) throw placementOccupiedError()
  return merchant.userId
}

/**
 * Admin approve（§7.3）：CAS pending_review → scheduled|active|payment_failed。
 * 同事务：行锁 → 重验 → 条件扣款+PointLog → 状态/startsAt/endsAt → AdminLog。
 * 并发 approve：行锁串行化，第二个看到非 pending_review → 稳定 409
 * CAMPAIGN_TRANSITION_INVALID（AC-MERCH-012）。placement partial unique 冲突
 * （两个不同 campaign 并发抢占同一 product+placement）→ P2002 → 409 PLACEMENT_OCCUPIED，
 * 事务整体回滚，不留扣款/PointLog（不泄露约束名）。
 */
export async function approveCampaign(
  adminUserId: number,
  campaignId: number,
  db: TransactionHost = prisma,
): Promise<ApproveCampaignResult> {
  await assertAdmin(adminUserId, db)
  try {
    const result = await db.$transaction(async tx => {
      const campaign = await lockCampaignRow(tx, campaignId)
      if (!campaign) throw notFound('推广活动不存在')
      if (campaign.status !== CAMPAIGN_STATUS.PENDING_REVIEW) {
        throw transitionInvalidError('当前状态不允许批准')
      }
      const merchantUserId = await assertApprovable(tx, campaign, { requirePackageActive: true })
      const now = await dbNow(tx)
      const result = await applyChargeAndSchedule(tx, { campaign, merchantUserId, adminUserId, now })
      await writeAdminLog(
        tx,
        adminUserId,
        result.kind === 'charged' ? '批准推广活动并扣款' : '批准推广活动（余额不足）',
        'promotion_campaign',
        campaignId,
        `status=${result.campaign.status}`,
      )
      return result
    })
    recordChargeOutcome(result.kind === 'charged' ? 'charged' : 'insufficient')
    if (result.kind === 'charged') {
      recordCampaignTransition(CAMPAIGN_STATUS.PENDING_REVIEW, result.campaign.status)
      invalidateSponsoredCache()
    }
    return result
  } catch (err) {
    if (isPlacementUniqueViolation(err)) {
      recordChargeOutcome('failed')
      throw placementOccupiedError()
    }
    throw err
  }
}

/**
 * Merchant retry-payment（§7.3 / D-MERCH-11）：CAS payment_failed → scheduled|active。
 * 仍使用已批准的价格快照；套餐失效不影响 retry。余额仍不足 → 保持 payment_failed
 * （不扣款、不写 PointLog）。跨 merchant 隔离：不是自己的 campaign → 404。
 */
export async function retryCampaignPayment(
  merchantId: number,
  _userId: number,
  campaignId: number,
  db: TransactionHost = prisma,
): Promise<{ kind: 'charged' | 'payment_failed'; campaign: MerchantCampaignDto }> {
  try {
    const result = await db.$transaction(async tx => {
      const campaign = await lockCampaignRow(tx, campaignId)
      if (!campaign) throw notFound('推广活动不存在')
      if (campaign.merchantId !== merchantId) throw notFound('推广活动不存在')
      if (campaign.status !== CAMPAIGN_STATUS.PAYMENT_FAILED) {
        throw transitionInvalidError('当前状态不允许重试支付')
      }
      const merchantUserId = await assertApprovable(tx, campaign, { requirePackageActive: false })
      const now = await dbNow(tx)
      const result = await applyChargeAndSchedule(tx, { campaign, merchantUserId, now })
      const row = await fetchBillingRow(tx, campaignId)
      return {
        kind: result.kind,
        campaign: toMerchantCampaignDto(row),
      }
    })
    recordChargeOutcome(result.kind === 'charged' ? 'charged' : 'insufficient')
    if (result.kind === 'charged') {
      recordCampaignTransition(CAMPAIGN_STATUS.PAYMENT_FAILED, result.campaign.status)
      invalidateSponsoredCache()
    }
    return result
  } catch (err) {
    if (isPlacementUniqueViolation(err)) {
      recordChargeOutcome('failed')
      throw placementOccupiedError()
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// pause / resume（§7.1；paused 继续占位、结束时间不顺延）
// ---------------------------------------------------------------------------

export async function pauseCampaign(adminUserId: number, campaignId: number, db: TransactionHost = prisma): Promise<AdminCampaignDto> {
  await assertAdmin(adminUserId, db)
  const result = await db.$transaction(async tx => {
    const campaign = await lockCampaignRow(tx, campaignId)
    if (!campaign) throw notFound('推广活动不存在')
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
      if (campaign.status === CAMPAIGN_STATUS.PAUSED) {
        return { campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaignId)), changed: false } // 幂等
      }
      throw transitionInvalidError('当前状态不允许暂停')
    }
    await tx.promotionCampaign.updateMany({
      where: { id: campaignId, status: CAMPAIGN_STATUS.ACTIVE },
      data: { status: CAMPAIGN_STATUS.PAUSED },
    })
    await writeAdminLog(tx, adminUserId, '暂停推广活动', 'promotion_campaign', campaignId, 'status=paused')
    return { campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaignId)), changed: true }
  })
  if (result.changed) {
    recordCampaignTransition(CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED)
    invalidateSponsoredCache()
  }
  return result.campaign
}

export async function resumeCampaign(adminUserId: number, campaignId: number, db: TransactionHost = prisma): Promise<AdminCampaignDto> {
  await assertAdmin(adminUserId, db)
  const result = await db.$transaction(async tx => {
    const campaign = await lockCampaignRow(tx, campaignId)
    if (!campaign) throw notFound('推广活动不存在')
    if (campaign.status !== CAMPAIGN_STATUS.PAUSED) {
      if (campaign.status === CAMPAIGN_STATUS.ACTIVE) {
        return { campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaignId)), changed: false } // 幂等
      }
      throw transitionInvalidError('当前状态不允许恢复')
    }
    await tx.promotionCampaign.updateMany({
      where: { id: campaignId, status: CAMPAIGN_STATUS.PAUSED },
      data: { status: CAMPAIGN_STATUS.ACTIVE },
    })
    await writeAdminLog(tx, adminUserId, '恢复推广活动', 'promotion_campaign', campaignId, 'status=active')
    return { campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaignId)), changed: true }
  })
  if (result.changed) {
    recordCampaignTransition(CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.ACTIVE)
    invalidateSponsoredCache()
  }
  return result.campaign
}

// ---------------------------------------------------------------------------
// 一次性退款调整决定（refund-adjustment + active/paused cancel 共用）
// ---------------------------------------------------------------------------

export type AdjustRefundResult =
  | { kind: 'decided'; campaign: AdminCampaignDto; replayed: false }
  | { kind: 'replayed'; campaign: AdminCampaignDto; replayed: true }

/**
 * P0 最多一次 active/paused 调整决定（§7.4 / D-MERCH-13）：
 *   - 强制 §11 Idempotency-Key（缺失/非法 → 400）；
 *   - canonical hash = ["campaign-adjustment-v1",campaignId,points,normalizedReason]
 *     （frozen vector 由 promotions-idempotency 测试覆盖）；
 *   - 已决定：同 key/同 hash → 重放既有决定（replayed=true）；同 key/异 hash →
 *     409 IDEMPOTENCY_KEY_REUSED；异 key（第二个新决定）→ 409
 *     CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED；
 *   - 未决定：行锁 + `adjustmentDecidedAt IS NULL` CAS 写入 adjustment 字段；
 *     points>0 才写唯一 refund PointLog/refundPointLogId；points=0 仍留下
 *     “明确不退”的不可变决定 + AdminLog。refund 永不超 chargedPoints。
 */
async function decideAdjustment(
  tx: Prisma.TransactionClient,
  input: {
    campaign: CampaignLockedRow
    key: string
    hash: string
    points: number
    reason: string
    byUserId: number
  },
): Promise<AdjustRefundResult> {
  const { campaign, key, hash, points, reason, byUserId } = input

  if (campaign.adjustmentDecidedAt !== null) {
    if (campaign.adjustmentIdempotencyKey === key) {
      if (campaign.adjustmentPayloadHash === hash) {
        return { kind: 'replayed', campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaign.id)), replayed: true }
      }
      throw keyReusedError()
    }
    throw adjustmentAlreadyDecidedError()
  }

  if (!Number.isInteger(points) || points < 0 || points > campaign.chargedPoints) {
    throw new HttpError(400, 'BAD_REQUEST', '调整金额必须在 0 与已扣积分之间')
  }

  const now = await dbNow(tx)

  let refundPointLogId: number | null = null
  if (points > 0) {
    const merchant = await tx.merchant.findUnique({
      where: { id: campaign.merchantId },
      select: { id: true, userId: true },
    })
    if (!merchant) throw notFound('商家不存在')
    const refund = await creditPointsForPromotionRefund(tx, merchant.userId, points)
    refundPointLogId = refund.pointLogId
  }

  const updated = await tx.promotionCampaign.updateMany({
    where: { id: campaign.id, adjustmentDecidedAt: null },
    data: {
      adjustmentDecidedAt: now,
      adjustmentByUserId: byUserId,
      adjustmentReason: reason,
      adjustmentIdempotencyKey: key,
      adjustmentPayloadHash: hash,
      refundedPoints: points,
      ...(refundPointLogId !== null ? { refundPointLogId } : {}),
    },
  })
  if (updated.count !== 1) {
    // 并发第二个决定赢得 CAS（行锁之外的 DB 最终兜底）→ 稳定 409。
    throw adjustmentAlreadyDecidedError()
  }

  await writeAdminLog(
    tx,
    byUserId,
    points > 0 ? '推广活动退款调整' : '推广活动退款调整（不退）',
    'promotion_campaign',
    campaign.id,
    `points=${points}`,
  )
  return { kind: 'decided', campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaign.id)), replayed: false }
}

/**
 * Admin refund-adjustment（§11 POST .../refund-adjustment）：只允许 active/paused；
 * 强制 Idempotency-Key；其余语义见 decideAdjustment。
 */
export async function adjustCampaignRefund(
  adminUserId: number,
  campaignId: number,
  input: { points: number; reason: string },
  idempotencyKeyRaw: string | undefined | null,
  db: TransactionHost = prisma,
): Promise<AdjustRefundResult> {
  await assertAdmin(adminUserId, db)
  const key = validateIdempotencyKey(idempotencyKeyRaw)
  const hash = canonicalizeCampaignAdjustment({
    campaignId,
    points: input.points,
    reason: input.reason,
  })
  try {
    const result = await db.$transaction(async tx => {
      const campaign = await lockCampaignRow(tx, campaignId)
      if (!campaign) throw notFound('推广活动不存在')
      if (campaign.status !== CAMPAIGN_STATUS.ACTIVE && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
        throw transitionInvalidError('只有进行中或已暂停的推广活动可以调整退款')
      }
      return decideAdjustment(tx, { campaign, key, hash, points: input.points, reason: input.reason, byUserId: adminUserId })
    })
    recordAdjustmentOutcome(result.kind === 'decided' ? 'decided' : 'replayed')
    if (result.kind === 'decided') invalidateSponsoredCache()
    return result
  } catch (err) {
    if (err instanceof HttpError && (
      String(err.code) === PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REUSED
      || String(err.code) === PROMOTION_ERROR_CODES.CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED
    )) recordAdjustmentOutcome('conflict')
    throw err
  }
}

// ---------------------------------------------------------------------------
// admin cancel（§7.1/§7.4）
// ---------------------------------------------------------------------------

export type AdminCancelResult =
  | { kind: 'cancelled'; campaign: AdminCampaignDto; refunded: boolean; replayed: false }
  | { kind: 'replayed'; campaign: AdminCampaignDto; refunded: boolean; replayed: true }

/**
 * Admin cancel：
 *   - scheduled（开跑前）→ 全额自动退（chargedPoints 全退 + 唯一 refund PointLog +
 *     cancelled），refundPointLogId 幂等，重复 cancel 不二次退（AC-MERCH-014）；
 *   - pending_review / payment_failed / rejected（未扣款）→ cancelled 不退；
 *   - active/paused → cancelled + 一次性显式调整决定（强制 Idempotency-Key，
 *     body points/reason 走 decideAdjustment）；P0 无第二次调整入口；
 *   - cancelled → 幂等重放；expired → 409。
 */
export async function adminCancelCampaign(
  adminUserId: number,
  campaignId: number,
  input: { reason?: string; points?: number },
  idempotencyKeyRaw: string | undefined | null,
  db: TransactionHost = prisma,
): Promise<AdminCancelResult> {
  await assertAdmin(adminUserId, db)
  const outcome = await db.$transaction(async tx => {
    const campaign = await lockCampaignRow(tx, campaignId)
    if (!campaign) throw notFound('推广活动不存在')

    if (campaign.status === CAMPAIGN_STATUS.CANCELLED) {
      // 已终态：幂等重放（不二次退款）。
      return { result: { kind: 'replayed', campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaignId)), refunded: campaign.refundedPoints > 0, replayed: true } as AdminCancelResult }
    }
    if (campaign.status === CAMPAIGN_STATUS.EXPIRED) {
      throw transitionInvalidError('已过期的推广活动不能取消')
    }

    const now = await dbNow(tx)

    if (campaign.status === CAMPAIGN_STATUS.SCHEDULED) {
      if (campaign.chargedPoints <= 0) {
        throw transitionInvalidError('当前状态不允许取消')
      }
      const merchant = await tx.merchant.findUnique({
        where: { id: campaign.merchantId },
        select: { id: true, userId: true },
      })
      if (!merchant) throw notFound('商家不存在')
      const refund = await creditPointsForPromotionRefund(tx, merchant.userId, campaign.chargedPoints)
      const updated = await tx.promotionCampaign.update({
        where: { id: campaignId },
        data: {
          status: CAMPAIGN_STATUS.CANCELLED,
          refundedPoints: campaign.chargedPoints,
          refundPointLogId: refund.pointLogId,
          cancelledByUserId: adminUserId,
          cancellationReason: input.reason ?? '平台取消排期',
        },
        select: billingCampaignSelect,
      })
      await writeAdminLog(tx, adminUserId, '取消推广活动（全额退款）', 'promotion_campaign', campaignId, `refund=${campaign.chargedPoints}`)
      return {
        result: { kind: 'cancelled', campaign: toAdminCampaignDto(updated as unknown as BillingRow), refunded: true, replayed: false } as AdminCancelResult,
        transition: [CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.CANCELLED] as const,
      }
    }

    if (
      campaign.status === CAMPAIGN_STATUS.PENDING_REVIEW
      || campaign.status === CAMPAIGN_STATUS.PAYMENT_FAILED
      || campaign.status === CAMPAIGN_STATUS.REJECTED
    ) {
      const updated = await tx.promotionCampaign.update({
        where: { id: campaignId },
        data: {
          status: CAMPAIGN_STATUS.CANCELLED,
          cancelledByUserId: adminUserId,
          cancellationReason: input.reason ?? '管理员取消',
        },
        select: billingCampaignSelect,
      })
      await writeAdminLog(tx, adminUserId, '取消推广活动', 'promotion_campaign', campaignId, '未扣款取消')
      return {
        result: { kind: 'cancelled', campaign: toAdminCampaignDto(updated as unknown as BillingRow), refunded: false, replayed: false } as AdminCancelResult,
        transition: [campaign.status, CAMPAIGN_STATUS.CANCELLED] as const,
      }
    }

    if (campaign.status === CAMPAIGN_STATUS.ACTIVE || campaign.status === CAMPAIGN_STATUS.PAUSED) {
      // 开跑后取消 = cancelled + 一次性显式调整决定（强制 Idempotency-Key）。
      const key = validateIdempotencyKey(idempotencyKeyRaw)
      const points = input.points ?? 0
      const reason = input.reason ?? '管理员取消'
      const hash = canonicalizeCampaignAdjustment({ campaignId, points, reason })
      const decision = await decideAdjustment(tx, { campaign, key, hash, points, reason, byUserId: adminUserId })
      const cancelled = await tx.promotionCampaign.updateMany({
        where: { id: campaignId, status: { in: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED] } },
        data: {
          status: CAMPAIGN_STATUS.CANCELLED,
          cancelledByUserId: adminUserId,
          cancellationReason: input.reason ?? '管理员取消',
        },
      })
      if (cancelled.count !== 1) {
        throw transitionInvalidError('当前状态不允许取消')
      }
      await writeAdminLog(tx, adminUserId, '取消推广活动', 'promotion_campaign', campaignId, `refund=${points}`)
      return {
        result: {
          kind: decision.kind === 'replayed' ? 'replayed' : 'cancelled',
          campaign: toAdminCampaignDto(await fetchBillingRow(tx, campaignId)),
          refunded: points > 0,
          replayed: decision.kind === 'replayed',
        } as AdminCancelResult,
        transition: [campaign.status, CAMPAIGN_STATUS.CANCELLED] as const,
        adjustment: decision.kind,
      }
    }

    throw transitionInvalidError('当前状态不允许取消')
  })
  if (outcome.transition) {
    recordCampaignTransition(outcome.transition[0], outcome.transition[1])
    invalidateSponsoredCache()
  }
  if (outcome.adjustment) {
    recordAdjustmentOutcome(outcome.adjustment === 'decided' ? 'decided' : 'replayed')
  }
  return outcome.result
}
