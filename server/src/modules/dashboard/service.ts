import { performance } from 'node:perf_hooks'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import type {
  DashboardStatusBreakdown,
  DashboardSummary,
  DashboardTimeseries,
  DashboardTopProduct,
  DashboardSeriesPoint,
  Range,
} from './types.js'

const RANGE_DAYS: Record<Range, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

const PAID_STATUSES = ['paid', 'pending', 'processing']
const FULFILLED_STATUSES = ['fulfilled', 'delivered', 'completed', 'closed']

interface SeriesRow {
  date: string
  orderCount: number | bigint
  pointsRevenue: number | bigint | null
}

interface TopProductRow {
  productId: number
  name: string
  soldCount: number | bigint
  pointsRevenue: number | bigint | null
}

function startOfCurrentMonth() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

function startOfNextMonth() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1)
}

function getRangeWindow(range: Range) {
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)

  const start = new Date(end)
  start.setDate(start.getDate() - RANGE_DAYS[range])

  return { start, end }
}

function toNumber(value: number | bigint | null | undefined) {
  return Number(value ?? 0)
}

function logDuration(op: 'dashboard.summary' | 'dashboard.timeseries', merchantId: number, startedAt: number) {
  logger.info({
    op,
    merchantId,
    duration_ms: Math.round(performance.now() - startedAt),
  })
}

export async function getSummary(merchantId: number): Promise<DashboardSummary> {
  const startedAt = performance.now()
  const monthStart = startOfCurrentMonth()
  const nextMonthStart = startOfNextMonth()

  const [monthOrderCount, monthRevenueResult, onSaleProductCount, pendingSettlementResult] = await Promise.all([
    prisma.order.count({ where: { merchantId, createdAt: { gte: monthStart, lt: nextMonthStart } } }),
    prisma.order.aggregate({ where: { merchantId, createdAt: { gte: monthStart, lt: nextMonthStart }, status: { not: 'refunded' } }, _sum: { price: true } }),
    prisma.product.count({ where: { merchantId, status: 'active' } }),
    prisma.settlement.aggregate({
      where: { merchantId, status: 'pending' },
      _sum: { settlementAmount: true },
    }),
  ])

  const result = {
    monthOrderCount,
    monthPointsRevenue: monthRevenueResult._sum.price ?? 0,
    onSaleProductCount,
    pendingSettlementPoints: pendingSettlementResult._sum.settlementAmount ?? 0,
  }
  logDuration('dashboard.summary', merchantId, startedAt)
  return result
}

async function getSeriesPoints(merchantId: number, start: Date, end: Date): Promise<DashboardSeriesPoint[]> {
  const rows = await prisma.$queryRaw<SeriesRow[]>`
    SELECT
      to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "date",
      COUNT(*)::int AS "orderCount",
      COALESCE(SUM("price"), 0)::int AS "pointsRevenue"
    FROM "Order"
    WHERE "merchantId" = ${merchantId}
      AND "createdAt" >= ${start}
      AND "createdAt" < ${end}
      AND "status" <> 'refunded'
    GROUP BY date_trunc('day', "createdAt")
    ORDER BY date_trunc('day', "createdAt") ASC
  `

  return rows.map(row => ({
    date: row.date,
    orderCount: toNumber(row.orderCount),
    pointsRevenue: toNumber(row.pointsRevenue),
  }))
}

async function getTopProducts(merchantId: number, start: Date, end: Date): Promise<DashboardTopProduct[]> {
  const rows = await prisma.$queryRaw<TopProductRow[]>`
    SELECT
      o."productId" AS "productId",
      p."name" AS "name",
      COUNT(*)::int AS "soldCount",
      COALESCE(SUM(o."price"), 0)::int AS "pointsRevenue"
    FROM "Order" o
    INNER JOIN "Product" p ON p."id" = o."productId" AND p."merchantId" = ${merchantId}
    WHERE o."merchantId" = ${merchantId}
      AND o."createdAt" >= ${start}
      AND o."createdAt" < ${end}
      AND o."status" <> 'refunded'
    GROUP BY o."productId", p."name"
    ORDER BY COUNT(*) DESC, COALESCE(SUM(o."price"), 0) DESC, o."productId" ASC
    LIMIT 10
  `

  return rows.map(row => ({
    productId: row.productId,
    name: row.name,
    soldCount: toNumber(row.soldCount),
    pointsRevenue: toNumber(row.pointsRevenue),
  }))
}

async function getStatusBreakdown(merchantId: number, start: Date, end: Date): Promise<DashboardStatusBreakdown> {
  const [paid, fulfilled, refunded] = await Promise.all([
    prisma.order.count({ where: { merchantId, createdAt: { gte: start, lt: end }, status: { in: PAID_STATUSES } } }),
    prisma.order.count({ where: { merchantId, createdAt: { gte: start, lt: end }, status: { in: FULFILLED_STATUSES } } }),
    prisma.order.count({ where: { merchantId, createdAt: { gte: start, lt: end }, status: 'refunded' } }),
  ])

  return { paid, fulfilled, refunded }
}

export async function getTimeseries(merchantId: number, range: Range): Promise<DashboardTimeseries> {
  const startedAt = performance.now()
  const { start, end } = getRangeWindow(range)

  const [points, top10, statusBreakdown] = await Promise.all([
    getSeriesPoints(merchantId, start, end),
    getTopProducts(merchantId, start, end),
    getStatusBreakdown(merchantId, start, end),
  ])

  const result = {
    range,
    points,
    top10,
    statusBreakdown,
  }
  logDuration('dashboard.timeseries', merchantId, startedAt)
  return result
}
