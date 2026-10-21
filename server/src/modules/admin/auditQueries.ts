import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import {
  parseAndValidateStrictDate,
  parseAndValidateStrictRefundDate,
  type ListAdminAuditQuery,
  type ListPointLogsQuery,
} from './schema.js'

/**
 * Dedicated paginated and filtered point logs read model.
 */
export async function listPointLogs(query: ListPointLogsQuery) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const skip = (page - 1) * pageSize

  const where: Prisma.PointLogWhereInput = {}

  if (query.userId) {
    where.userId = query.userId
  }

  if (query.email) {
    where.user = {
      email: query.email.trim().toLowerCase(),
    }
  }

  if (query.type) {
    where.type = query.type
  }

  const createdAtFilter: Prisma.DateTimeFilter = {}
  if (query.from) {
    const parsedFrom = parseAndValidateStrictRefundDate(query.from)
    if (parsedFrom.valid && parsedFrom.date) {
      createdAtFilter.gte = parsedFrom.date
    }
  }
  if (query.to) {
    const parsedTo = parseAndValidateStrictRefundDate(query.to)
    if (parsedTo.valid && parsedTo.date) {
      if (parsedTo.isDateOnly) {
        const nextDay = new Date(parsedTo.date.getTime())
        nextDay.setUTCDate(nextDay.getUTCDate() + 1)
        createdAtFilter.lt = nextDay
      } else {
        createdAtFilter.lte = parsedTo.date
      }
    }
  }
  if (createdAtFilter.gte || createdAtFilter.lt || createdAtFilter.lte) {
    where.createdAt = createdAtFilter
  }

  const [total, items] = await prisma.$transaction([
    prisma.pointLog.count({ where }),
    prisma.pointLog.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            nickname: true,
          },
        },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      skip,
      take: pageSize,
    }),
  ])

  return { items, total, page, pageSize }
}

/**
 * @deprecated Legacy point logs query returning unpaginated array (up to 100).
 * Kept for backward compatibility. Use listPointLogs instead.
 */
export async function listLogs() {
  return prisma.pointLog.findMany({
    include: {
      user: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
}

export async function listAdminLogs(query: ListAdminAuditQuery) {
  const where: Prisma.AdminLogWhereInput = {}

  if (query.adminId) where.adminUserId = query.adminId
  if (query.action) where.action = query.action
  if (query.targetType) where.targetType = query.targetType
  if (query.fromDate || query.toDate) {
    const createdAtFilter: Prisma.DateTimeFilter = {}
    if (query.fromDate) {
      const fromParsed = parseAndValidateStrictDate(query.fromDate)
      if (fromParsed.date) {
        createdAtFilter.gte = fromParsed.date
      }
    }
    if (query.toDate) {
      const toParsed = parseAndValidateStrictDate(query.toDate)
      if (toParsed.date) {
        if (toParsed.isDateOnly) {
          createdAtFilter.lt = new Date(toParsed.date.getTime() + 24 * 60 * 60 * 1000)
        } else {
          createdAtFilter.lte = toParsed.date
        }
      }
    }
    where.createdAt = createdAtFilter
  }

  const [items, total] = await prisma.$transaction([
    prisma.adminLog.findMany({
      where,
      select: {
        id: true,
        adminUserId: true,
        action: true,
        targetType: true,
        targetId: true,
        createdAt: true,
        admin: {
          select: {
            email: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.adminLog.count({ where }),
  ])

  return {
    items: items.map(log => ({
      id: log.id,
      adminId: log.adminUserId,
      adminEmail: log.admin.email,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      createdAt: log.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

// ---- P5.5 T2：全平台热销规格报表 ----

const OFFER_REPORT_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const

interface AdminOfferReportRow {
  offerId: number | null
  productId: number
  merchantId: number | null
  offerName: string
  productName: string
  merchantName: string | null
  soldCount: number | bigint
  pointsRevenue: number | bigint | null
}

/**
 * 全平台热销规格 top-20。口径 = 净成交（排除 refunded）——`Offer.sales` 是
 * 只增计数器，不作报表数据源。按 (offerId, productId, merchantId) 分组：
 * 非空 offerId 本就唯一确定商品与商家，等价于按 offerId 分组；offerId IS NULL
 * 的历史单则按商品拆桶，保证 productId 列有确定含义。规格名优先取当前
 * Offer.name（改名即时生效），规格行缺失时回退最近一笔订单的 offerNameSnapshot，
 * NULL 桶固定为「未指定规格」。
 */
export async function getOfferReport(range: keyof typeof OFFER_REPORT_RANGE_DAYS) {
  const start = new Date(Date.now() - OFFER_REPORT_RANGE_DAYS[range] * 24 * 60 * 60 * 1000)

  const rows = await prisma.$queryRaw<AdminOfferReportRow[]>`
    SELECT
      o."offerId" AS "offerId",
      o."productId" AS "productId",
      o."merchantId" AS "merchantId",
      COALESCE(
        MAX(ofr."name"),
        (array_agg(o."offerNameSnapshot" ORDER BY o."createdAt" DESC, o."id" DESC)
          FILTER (WHERE o."offerNameSnapshot" IS NOT NULL))[1],
        '未指定规格'
      ) AS "offerName",
      MAX(p."name") AS "productName",
      MAX(m."name") AS "merchantName",
      COUNT(*)::int AS "soldCount",
      COALESCE(SUM(o."price"), 0)::int AS "pointsRevenue"
    FROM "Order" o
    INNER JOIN "Product" p ON p."id" = o."productId"
    LEFT JOIN "Offer" ofr ON ofr."id" = o."offerId"
    LEFT JOIN "Merchant" m ON m."id" = o."merchantId"
    WHERE o."createdAt" >= ${start}
      AND o."status" <> 'refunded'
    GROUP BY o."offerId", o."productId", o."merchantId"
    ORDER BY COALESCE(SUM(o."price"), 0) DESC, COUNT(*) DESC, o."productId" ASC, o."offerId" ASC NULLS LAST
    LIMIT 20
  `

  return {
    items: rows.map(row => ({
      offerId: row.offerId,
      offerName: row.offerName,
      productId: row.productId,
      productName: row.productName,
      merchantId: row.merchantId,
      merchantName: row.merchantName,
      soldCount: Number(row.soldCount ?? 0),
      pointsRevenue: Number(row.pointsRevenue ?? 0),
    })),
  }
}
