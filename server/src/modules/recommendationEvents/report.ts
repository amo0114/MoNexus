import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { wrapCache, makeCacheKey } from '../../lib/cache.js'
import { addCalendarDays, businessDateString, businessDayStartUtc } from '../../lib/businessTime.js'
import type { ReportQuery } from './schema.js'

const HOUR = 3_600_000
export async function calculateRecommendationReport(query: ReportQuery, now = new Date()) {
  const today = businessDateString(now)
  const start = businessDayStartUtc(addCalendarDays(today, 1 - parseInt(query.range, 10)))
  const dimension = query.groupBy === 'tier' ? Prisma.sql`e."tier"::text`
    : query.groupBy === 'position' ? Prisma.sql`e."position"::text`
      : Prisma.sql`CASE WHEN e."platformSeller" THEN 'platform' WHEN e."sameSeller" THEN 'same_seller' ELSE 'other_seller' END`
  // Each order selects exactly one last recorded click across all lists/strategy versions.
  // Order.createdAt is a UTC timestamp without zone; do not inherit the DB session timezone.
  // Exposures and conversion clicks retain their own cohort dates, including across midnight.
  const rows = await prisma.$queryRaw<Array<{
    date: string; strategyVersion: string; audience: string; position: number; dimension: string;
    impressions: number; uniqueImpressions: number; impliedImpressions: number; clickedImpressions: number;
    clicks: number; guestClicks: number; eligibleClicks: number; convertedClicks: number;
    rawOrders: number; netOrders: number; rawPoints: number; netPoints: number;
    rawOrders7d: number; netOrders7d: number; rawPoints7d: number; netPoints7d: number;
    convertedClicks7d: number; loginImpressions: number; exposureNetOrders: number; lists: number;
  }>>`
    WITH attributed AS (
      SELECT c."listId", c."productId", o."price", o."status",
        (o."createdAt" AT TIME ZONE 'UTC') <= c."receivedAt" + interval '24 hours' AS main
      FROM "Order" o
      CROSS JOIN LATERAL (
        SELECT "listId", "productId", "receivedAt" FROM "RecommendationClick" c
        WHERE c."userId" = o."userId" AND c."productId" = o."productId"
          AND c."receivedAt" < (o."createdAt" AT TIME ZONE 'UTC') AND c."receivedAt" >= (o."createdAt" AT TIME ZONE 'UTC') - interval '7 days'
        ORDER BY c."receivedAt" DESC, c."listId" DESC LIMIT 1
      ) c
      WHERE o."createdAt" >= (${start}::timestamptz AT TIME ZONE 'UTC') AND o."createdAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
    ), orders AS (
      SELECT "listId", "productId",
        COUNT(*) FILTER (WHERE main)::int AS raw,
        COUNT(*) FILTER (WHERE main AND "status" <> 'refunded')::int AS net,
        COALESCE(SUM("price") FILTER (WHERE main),0)::float8 AS rp,
        COALESCE(SUM("price") FILTER (WHERE main AND "status" <> 'refunded'),0)::float8 AS np,
        COUNT(*)::int AS raw7, COUNT(*) FILTER (WHERE "status" <> 'refunded')::int AS net7,
        SUM("price")::float8 AS rp7, COALESCE(SUM("price") FILTER (WHERE "status" <> 'refunded'),0)::float8 AS np7
      FROM attributed GROUP BY 1,2
    ), facts AS (
      SELECT e."receivedAt" AS at, e."strategyVersion", e."audience", e."position", ${dimension} AS dimension,
        e."listId", e."visitorId", e."sourceProductId", e."productId",
        1 AS impression, e."implied"::int AS implied, (c."listId" IS NOT NULL)::int AS clicked,
        (e."userId" IS NOT NULL)::int AS login,
        CASE WHEN e."userId" IS NOT NULL THEN COALESCE(o.net,0) ELSE 0 END AS exposure_orders,
        0 AS click, 0 AS guest, 0 AS eligible, 0 AS converted, 0 AS converted7,
        0 AS raw, 0 AS net, 0::float8 AS rp, 0::float8 AS np, 0 AS raw7, 0 AS net7, 0::float8 AS rp7, 0::float8 AS np7
      FROM "RecommendationImpression" e
      LEFT JOIN "RecommendationClick" c ON c."listId"=e."listId" AND c."productId"=e."productId" AND c."receivedAt" <= ${now}
      LEFT JOIN orders o ON o."listId"=c."listId" AND o."productId"=c."productId"
      WHERE e."receivedAt" >= ${start} AND e."receivedAt" <= ${now}
      UNION ALL
      SELECT e."receivedAt", e."strategyVersion", e."audience", e."position", ${dimension},
        e."listId", e."visitorId", e."sourceProductId", e."productId",
        0,0,0,0,0,1,(e."userId" IS NULL)::int,(e."userId" IS NOT NULL)::int,
        (COALESCE(o.net,0)>0)::int,(COALESCE(o.net7,0)>0)::int,
        COALESCE(o.raw,0),COALESCE(o.net,0),COALESCE(o.rp,0),COALESCE(o.np,0),
        COALESCE(o.raw7,0),COALESCE(o.net7,0),COALESCE(o.rp7,0),COALESCE(o.np7,0)
      FROM "RecommendationClick" e LEFT JOIN orders o ON o."listId"=e."listId" AND o."productId"=e."productId"
      WHERE e."receivedAt" >= ${start} AND e."receivedAt" <= ${now}
    )
    SELECT (at AT TIME ZONE 'Asia/Shanghai')::date::text AS date, "strategyVersion", audience, position, dimension,
      SUM(impression)::int AS impressions,
      COUNT(DISTINCT ("visitorId", "sourceProductId", "productId")) FILTER (WHERE impression=1)::int AS "uniqueImpressions",
      SUM(implied)::int AS "impliedImpressions", SUM(clicked)::int AS "clickedImpressions",
      SUM(click)::int AS clicks, SUM(guest)::int AS "guestClicks", SUM(eligible)::int AS "eligibleClicks",
      SUM(converted)::int AS "convertedClicks", SUM(converted7)::int AS "convertedClicks7d",
      SUM(raw)::int AS "rawOrders", SUM(net)::int AS "netOrders", SUM(rp)::float8 AS "rawPoints", SUM(np)::float8 AS "netPoints",
      SUM(raw7)::int AS "rawOrders7d", SUM(net7)::int AS "netOrders7d", SUM(rp7)::float8 AS "rawPoints7d", SUM(np7)::float8 AS "netPoints7d",
      SUM(login)::int AS "loginImpressions", SUM(exposure_orders)::int AS "exposureNetOrders",
      COUNT(DISTINCT "listId") FILTER (WHERE impression=1)::int AS lists
    FROM facts GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5
  `
  const [coverage] = await prisma.$queryRaw<Array<{ lists: number; impressions: number; detailPageViews: number }>>`
    SELECT COUNT(DISTINCT "listId")::int AS lists, COUNT(*)::int AS impressions,
      (SELECT COALESCE(SUM(pv),0)::int FROM "TrafficDailyVisitor"
       WHERE day >= (${start} AT TIME ZONE 'Asia/Shanghai')::date AND day <= (${now} AT TIME ZONE 'Asia/Shanghai')::date
       AND page LIKE '/product/%') AS "detailPageViews"
    FROM "RecommendationImpression" WHERE "receivedAt" >= ${start} AND "receivedAt" <= ${now}
  `
  const ratio = (n: number, d: number) => d ? n / d : null
  return {
    range: query.range, groupBy: query.groupBy, generatedAt: now.toISOString(),
    attributionWindowHours: 24, referenceWindowHours: 168,
    coverage: { ...coverage, rate: ratio(coverage.lists, coverage.detailPageViews), averageVisibleItems: ratio(coverage.impressions, coverage.lists), trendOnly: true },
    rows: rows.map(row => {
      const dayEnd = businessDayStartUtc(addCalendarDays(row.date, 1)).getTime()
      return { ...row,
        ctr: ratio(row.clickedImpressions, row.impressions), conversionRate: ratio(row.convertedClicks, row.eligibleClicks),
        conversionRate7d: ratio(row.convertedClicks7d, row.eligibleClicks),
        ordersPerThousandImpressions: row.loginImpressions ? row.exposureNetOrders / row.loginImpressions * 1000 : null,
        guestClickShare: ratio(row.guestClicks, row.clicks), averageVisibleItems: ratio(row.impressions, row.lists),
        insufficientSample: row.impressions < 1000 || row.clicks < 30,
        immature: {
          ctr: now.getTime() < dayEnd + 2 * HOUR,
          conversion: now.getTime() < dayEnd + 24 * HOUR,
          ordersPerThousand: now.getTime() < dayEnd + 26 * HOUR,
          reference7d: now.getTime() < dayEnd + 168 * HOUR,
        },
      }
    }),
    attributionIsIncrementalLift: false,
  }
}

export function getRecommendationReport(query: ReportQuery) {
  return wrapCache('recommendation-report', makeCacheKey('recommendation-report', query.range, query.groupBy), 30,
    () => calculateRecommendationReport(query))
}
