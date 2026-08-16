import { Prisma } from '@prisma/client'
import { badRequest, conflict, forbidden, notFound } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { getSystemConfigValue } from '../../../lib/systemConfig.js'
import { DISPLAY_LABEL, ENTITLEMENT_CODE, ENTITLEMENT_SOURCE, ENTITLEMENT_STATUS } from '../constants.js'
import { summarizeAdminAuditReason } from '../audit.js'

type TransactionHost = typeof prisma
type EntitlementDb = typeof prisma | Prisma.TransactionClient

const DAY_MS = 86_400_000
const MAX_MANUAL_GRANT_DAYS = 365

const entitlementAdminSelect = {
  id: true,
  merchantId: true,
  code: true,
  source: true,
  sourceRef: true,
  status: true,
  validFrom: true,
  validUntil: true,
  reason: true,
  grantedByUserId: true,
  revokedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const

async function dbNow(db: EntitlementDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AT TIME ZONE 'UTC' AS now`
  return rows[0].now
}

async function assertAdmin(userId: number, db: EntitlementDb): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (!user || user.role !== 'admin') throw forbidden('需要管理员权限')
}

async function lockMerchant(merchantId: number, tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId} FOR UPDATE`
  if (rows.length === 0) throw notFound('商家不存在')
}

async function expireDueForMerchant(
  merchantId: number,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const result = await tx.merchantEntitlement.updateMany({
    where: {
      merchantId,
      code: ENTITLEMENT_CODE.PARTNER,
      status: ENTITLEMENT_STATUS.ACTIVE,
      validUntil: { lte: now },
    },
    data: { status: ENTITLEMENT_STATUS.EXPIRED },
  })
  return result.count
}

export async function listAdminEntitlements(query: {
  merchantId?: number; status?: string; page?: number; pageSize?: number
} = {}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where = {
    ...(query.merchantId === undefined ? {} : { merchantId: query.merchantId }),
    ...(query.status === undefined ? {} : { status: query.status }),
    code: ENTITLEMENT_CODE.PARTNER,
  }
  const [total, items] = await prisma.$transaction([
    prisma.merchantEntitlement.count({ where }),
    prisma.merchantEntitlement.findMany({
      where,
      select: entitlementAdminSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return { items, total, page, pageSize }
}

/** Merchant DTO allowlist: never expose source/sourceRef/reason/admin actor fields. */
export async function listMerchantEntitlements(merchantId: number) {
  const now = await dbNow(prisma)
  const rows = await prisma.merchantEntitlement.findMany({
    where: {
      merchantId,
      code: ENTITLEMENT_CODE.PARTNER,
      status: ENTITLEMENT_STATUS.ACTIVE,
      validFrom: { lte: now },
      validUntil: { gt: now },
    },
    select: { code: true, validFrom: true, validUntil: true },
    orderBy: [{ validUntil: 'desc' }, { id: 'desc' }],
  })
  return rows.map(row => ({
    code: row.code,
    label: DISPLAY_LABEL.PARTNER,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil.toISOString(),
  }))
}

export async function manualGrantPartnerEntitlement(
  adminUserId: number,
  input: { merchantId: number; validUntil: string; reason: string },
  db: TransactionHost = prisma,
) {
  const validUntil = new Date(input.validUntil)
  return db.$transaction(async tx => {
    await assertAdmin(adminUserId, tx)
    await lockMerchant(input.merchantId, tx)
    const now = await dbNow(tx)
    if (validUntil <= now) throw badRequest('权益到期时间必须晚于当前数据库时间')
    if (validUntil.getTime() - now.getTime() > MAX_MANUAL_GRANT_DAYS * DAY_MS) {
      throw badRequest('手工授予有效期不能超过365天')
    }
    await expireDueForMerchant(input.merchantId, now, tx)
    const active = await tx.merchantEntitlement.findFirst({
      where: { merchantId: input.merchantId, code: ENTITLEMENT_CODE.PARTNER, status: ENTITLEMENT_STATUS.ACTIVE },
      select: { id: true },
    })
    if (active) throw conflict('该商家已有生效的平台合作伙伴权益')
    const entitlement = await tx.merchantEntitlement.create({
      data: {
        merchantId: input.merchantId,
        code: ENTITLEMENT_CODE.PARTNER,
        source: ENTITLEMENT_SOURCE.ADMIN_GRANT,
        sourceRef: null,
        status: ENTITLEMENT_STATUS.ACTIVE,
        validFrom: now,
        validUntil,
        reason: input.reason,
        grantedByUserId: adminUserId,
      },
      select: entitlementAdminSelect,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '授予平台合作伙伴权益',
        targetType: 'merchant_entitlement',
        targetId: entitlement.id,
        detail: `merchantId=${input.merchantId}; validUntil=${validUntil.toISOString()}; ${summarizeAdminAuditReason(input.reason)}`,
      },
    })
    return entitlement
  })
}

export async function revokePartnerEntitlement(
  adminUserId: number,
  entitlementId: number,
  reason: string,
  db: TransactionHost = prisma,
) {
  return db.$transaction(async tx => {
    await assertAdmin(adminUserId, tx)
    const current = await tx.merchantEntitlement.findUnique({
      where: { id: entitlementId },
      select: entitlementAdminSelect,
    })
    if (!current || current.code !== ENTITLEMENT_CODE.PARTNER) throw notFound('合作伙伴权益不存在')
    await lockMerchant(current.merchantId, tx)
    if (current.status === ENTITLEMENT_STATUS.REVOKED) return current
    if (current.status === ENTITLEMENT_STATUS.EXPIRED) throw conflict('已过期权益不能撤销')
    const updated = await tx.merchantEntitlement.update({
      where: { id: entitlementId },
      data: { status: ENTITLEMENT_STATUS.REVOKED, revokedByUserId: adminUserId },
      select: entitlementAdminSelect,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '撤销平台合作伙伴权益',
        targetType: 'merchant_entitlement',
        targetId: entitlementId,
        detail: `merchantId=${current.merchantId}; ${summarizeAdminAuditReason(reason)}`,
      },
    })
    return updated
  })
}

interface PromotionSpendRow {
  merchantId: number
  netPoints: bigint
}

export interface PartnerEntitlementJobResult {
  expired: number
  granted: number
  extended: number
  eligibleMerchants: number
}

async function reconcilePartnerEntitlementsAt(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<PartnerEntitlementJobResult> {
  const [windowDays, threshold, entitlementDays] = await Promise.all([
    getSystemConfigValue('partnerSpendWindowDays', tx),
    getSystemConfigValue('partnerMinPromotionPoints', tx),
    getSystemConfigValue('partnerEntitlementDays', tx),
  ])
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS)
  const targetValidUntil = new Date(now.getTime() + entitlementDays * DAY_MS)
  const dueRows = await tx.merchantEntitlement.findMany({
    where: { code: ENTITLEMENT_CODE.PARTNER, status: ENTITLEMENT_STATUS.ACTIVE, validUntil: { lte: now } },
    select: { merchantId: true },
  })
  const eligible = await tx.$queryRaw<PromotionSpendRow[]>`
    SELECT campaign."merchantId" AS "merchantId",
           SUM(campaign."chargedPoints" - campaign."refundedPoints")::bigint AS "netPoints"
    FROM "PromotionCampaign" campaign
    JOIN "PointLog" charge_log ON charge_log."id" = campaign."chargePointLogId"
    WHERE charge_log."createdAt" >= ${windowStart}
      AND charge_log."createdAt" < ${now}
      AND charge_log."type" = 'out'
      AND campaign."chargedPoints" > 0
    GROUP BY campaign."merchantId"
    HAVING SUM(campaign."chargedPoints" - campaign."refundedPoints") >= ${threshold}`
  const eligibleByMerchant = new Map(eligible.map(row => [row.merchantId, row]))
  const merchantIds = [...new Set([
    ...dueRows.map(row => row.merchantId),
    ...eligible.map(row => row.merchantId),
  ])].sort((a, b) => a - b)
  let expired = 0
  let granted = 0
  let extended = 0
  for (const merchantId of merchantIds) {
    await lockMerchant(merchantId, tx)
    expired += await expireDueForMerchant(merchantId, now, tx)
    const row = eligibleByMerchant.get(merchantId)
    if (!row) continue
    const active = await tx.merchantEntitlement.findFirst({
      where: { merchantId, code: ENTITLEMENT_CODE.PARTNER, status: ENTITLEMENT_STATUS.ACTIVE },
      select: { id: true, validUntil: true, source: true },
    })
    const netPoints = Number(row.netPoints)
    if (!Number.isSafeInteger(netPoints)) throw new Error(`partner net spend overflow for merchant ${merchantId}`)
    const sourceRef = `promotion-spend:${windowStart.toISOString()}:${now.toISOString()}`
    const reason = `近${windowDays}天净推广消费${netPoints}积分，达到${threshold}积分门槛`
    if (active) {
      if (active.validUntil < targetValidUntil) {
        await tx.merchantEntitlement.update({
          where: { id: active.id },
          data: {
            validUntil: targetValidUntil,
            ...(active.source === ENTITLEMENT_SOURCE.PROMOTION_SPEND ? {
              source: ENTITLEMENT_SOURCE.PROMOTION_SPEND,
              sourceRef,
              reason,
              grantedByUserId: null,
            } : {}),
          },
        })
        extended += 1
      }
      continue
    }
    await tx.merchantEntitlement.create({
      data: {
        merchantId,
        code: ENTITLEMENT_CODE.PARTNER,
        source: ENTITLEMENT_SOURCE.PROMOTION_SPEND,
        sourceRef,
        status: ENTITLEMENT_STATUS.ACTIVE,
        validFrom: now,
        validUntil: targetValidUntil,
        reason,
      },
    })
    granted += 1
  }
  return { expired, granted, extended, eligibleMerchants: eligible.length }
}

/**
 * DB-time, half-open promotion-spend reconciliation. The charge log timestamp
 * selects the campaign; current refundedPoints is always subtracted, even when
 * the refund happened outside the window.
 */
export async function reconcilePartnerEntitlements(db: TransactionHost = prisma): Promise<PartnerEntitlementJobResult> {
  return db.$transaction(async tx => reconcilePartnerEntitlementsAt(tx, await dbNow(tx)))
}

/** Real-PG boundary-test seam. Callers must supply a timestamp read from PostgreSQL. */
export async function __reconcilePartnerEntitlementsAtForTests(
  nowFromDatabase: Date,
  db: TransactionHost = prisma,
): Promise<PartnerEntitlementJobResult> {
  return db.$transaction(tx => reconcilePartnerEntitlementsAt(tx, nowFromDatabase))
}
