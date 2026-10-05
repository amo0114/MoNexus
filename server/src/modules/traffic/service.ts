import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { makeCacheKey, wrapCache } from '../../lib/cache.js'
import { addCalendarDays, businessDateString, businessDayStartUtc, calendarDayToUtc } from '../../lib/businessTime.js'
import { notFound } from '../../lib/httpError.js'
import { publicVisibilityWhere, type ProductAudience } from '../products/visibility.js'
import type { TrafficEventInput, TrafficRange } from './schema.js'

export const TRAFFIC_RETENTION_DAYS = 90
const BATCH_SIZE = 5_000

export async function recordTrafficEvent(input: TrafficEventInput, audience: ProductAudience) {
  const productId = input.page === '/' ? null : Number(input.page.slice('/product/'.length))
  let merchantId: number | null = null
  if (productId !== null) {
    // Ownership and visibility come from the server, never from tracking payloads.
    const product = await prisma.product.findFirst({
      where: { id: productId, ...publicVisibilityWhere(audience) },
      select: { merchantId: true },
    })
    if (!product) throw notFound('商品暂不可用')
    merchantId = product.merchantId
  }
  // A retry retains the same event ID. Acknowledge only after the insert commits.
  await prisma.trafficEvent.createMany({
    data: [{ id: input.eventId, visitorId: input.visitorId, page: input.page, productId, merchantId }],
    skipDuplicates: true,
  })
}

export async function aggregateTraffic() {
  return prisma.$transaction(async tx => {
    const events = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "TrafficEvent"
      WHERE "processedAt" IS NULL
      ORDER BY "receivedAt", "id"
      LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    `
    if (events.length) {
      const ids = Prisma.join(events.map(event => Prisma.sql`${event.id}::uuid`))
      // Instants are bucketed explicitly into Asia/Shanghai calendar days.
      // Increment and acknowledgement share the transaction, so a failed run is replayable.
      await tx.$executeRaw`
        INSERT INTO "TrafficDailyVisitor" ("day", "page", "visitorId", "productId", "merchantId", "pv")
        SELECT ("receivedAt" AT TIME ZONE 'Asia/Shanghai')::date,
          "page", "visitorId", "productId", "merchantId", COUNT(*)::integer
        FROM "TrafficEvent" WHERE "id" IN (${ids})
        GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3
        ON CONFLICT ("day", "page", "visitorId") DO UPDATE
          SET "pv" = "TrafficDailyVisitor"."pv" + EXCLUDED."pv"
      `
      await tx.trafficEvent.updateMany({
        where: { id: { in: events.map(event => event.id) } },
        data: { processedAt: new Date() },
      })
    }
    const oldestDay = addCalendarDays(businessDateString(), 1 - TRAFFIC_RETENTION_DAYS)
    await tx.trafficEvent.deleteMany({
      where: { receivedAt: { lt: businessDayStartUtc(oldestDay) }, processedAt: { not: null } },
    })
    await tx.trafficDailyVisitor.deleteMany({ where: { day: { lt: calendarDayToUtc(oldestDay) } } })
    await tx.trafficAggregationState.upsert({
      where: { id: 1 }, create: { id: 1, updatedAt: new Date() }, update: { updatedAt: new Date() },
    })
    return events.length
  }, { timeout: 30_000 })
}

type Counts = { pv: number; uv: number }
type DailyCounts = Counts & { date: string }
type ProductCounts = Counts & { productId: number; name: string }
type MerchantCounts = Counts & { merchantId: number | null; name: string }

export async function getTrafficReport(range: TrafficRange, merchantId?: number) {
  const today = businessDateString()
  const days = Number.parseInt(range, 10)
  const start = addCalendarDays(today, 1 - days)
  // Scope is part of the cache key; merchant IDs only arrive from authenticated middleware.
  const key = makeCacheKey('traffic-report', merchantId === undefined ? 'platform' : `merchant-${merchantId}`, range, today)
  return wrapCache('traffic-report', key, 30, () => prisma.$transaction(async tx => {
    const filter = Prisma.sql`v."day" >= ${start}::date AND v."day" <= ${today}::date
      ${merchantId === undefined ? Prisma.empty : Prisma.sql`AND v."merchantId" = ${merchantId}`}`
    const [totals] = await tx.$queryRaw<Counts[]>`
      SELECT COALESCE(SUM(v."pv"), 0)::integer AS pv, COUNT(DISTINCT v."visitorId")::integer AS uv
      FROM "TrafficDailyVisitor" v WHERE ${filter}
    `
    const daily = await tx.$queryRaw<DailyCounts[]>`
      SELECT to_char(v."day", 'YYYY-MM-DD') AS date,
        SUM(v."pv")::integer AS pv, COUNT(DISTINCT v."visitorId")::integer AS uv
      FROM "TrafficDailyVisitor" v WHERE ${filter}
      GROUP BY v."day" ORDER BY v."day"
    `
    const topProducts = await tx.$queryRaw<ProductCounts[]>`
      SELECT v."productId", COALESCE(p."name", '已删除商品 #' || v."productId") AS name,
        SUM(v."pv")::integer AS pv, COUNT(DISTINCT v."visitorId")::integer AS uv
      FROM "TrafficDailyVisitor" v LEFT JOIN "Product" p ON p.id = v."productId"
      WHERE ${filter} AND v."productId" IS NOT NULL
      GROUP BY v."productId", p."name" ORDER BY pv DESC, v."productId" LIMIT 10
    `
    const topMerchants = merchantId === undefined ? await tx.$queryRaw<MerchantCounts[]>`
      SELECT v."merchantId",
        CASE WHEN v."merchantId" IS NULL THEN '平台自营'
          ELSE COALESCE(m."name", '已删除商家 #' || v."merchantId") END AS name,
        SUM(v."pv")::integer AS pv, COUNT(DISTINCT v."visitorId")::integer AS uv
      FROM "TrafficDailyVisitor" v LEFT JOIN "Merchant" m ON m.id = v."merchantId"
      WHERE ${filter} AND v."productId" IS NOT NULL
      GROUP BY v."merchantId", m."name" ORDER BY pv DESC, v."merchantId" LIMIT 10
    ` : []
    const state = await tx.trafficAggregationState.findUnique({ where: { id: 1 } })
    const pendingEvents = await tx.trafficEvent.count({
      where: { processedAt: null, ...(merchantId === undefined ? {} : { merchantId }) },
    })
    const byDay = new Map(daily.map(point => [point.date, point]))
    return {
      range, timeZone: 'Asia/Shanghai' as const, startDate: start, endDate: today,
      scope: merchantId === undefined ? 'platform' as const : 'merchant' as const,
      totals, points: Array.from({ length: days }, (_, index) => {
        const date = addCalendarDays(start, index)
        return byDay.get(date) ?? { date, pv: 0, uv: 0 }
      }),
      topProducts, topMerchants, pendingEvents,
      startedAt: state?.startedAt.toISOString() ?? null,
      updatedAt: state?.updatedAt?.toISOString() ?? null,
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }))
}
