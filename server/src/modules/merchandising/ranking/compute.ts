// T-MERCH-BE-002 — Ranking compute: real Order aggregation (SPEC-MERCH-001 §6).
//
// Frozen semantics (CHK-HOT-002/003/005/008/009, AC-MERCH-003/004/006):
//   - window 半开区间 [windowStart, windowEnd)：`createdAt >= windowStart AND < windowEnd`；
//   - 口径 = `status <> 'refunded'`：pending/processing/delivered/closed/disputed 均计入
//     （disputed 仍是已支付订单；退款在下一 run 排除）；人工 pending/processing 按已冻结
//     积分而非已扣款理解（D-MERCH-02）；
//   - 每张 Order 计数 1（一个 Order 购买一个商品，spec §6.1）；
//   - 只排名 active Product；draft/inactive 不参与 active population（历史 Order 不删除）；
//   - 绝不读取 Product.sales / Offer.sales / Product.isHot（SQL 不投影这些列，
//     CHK-HOT-002 / MERCH-002 / AC-MERCH-003）；
//   - category 内按 `effectiveOrderCount DESC, productId DESC` 稳定 row number（D-MERCH-05）；
//   - isHot = `count >= minSales AND rank <= ceil(population * topPercent / 100)`（D-MERCH-05）。
//
// 聚合 SQL 只返回 (productId, categoryId, effectiveOrderCount, categoryPopulation)；
// rank/isHot 由纯函数 computeCategoryRanks 计算（无 DB 可单测；确定性来自冻结 tie-break）。

import { Prisma } from '@prisma/client'
import { setRankingCompute } from './cron.js'
import type { RunCompute, SnapshotInput } from './types.js'

/** 聚合 SQL 返回的原始行（int4 → JS number）。 */
export interface AggregationRow {
  productId: number
  categoryId: number
  effectiveOrderCount: number
  categoryPopulation: number
}

/**
 * 冻结的聚合 SQL（spec §6.1 的 SQL 逻辑等价物）。写成可复用的 `Prisma.Sql`
 * 以便：①参数化绑定 windowStart/windowEnd（无 SQL 注入）；②契约测试直接断言
 * `.text` 不引用 Product/Offer.sales 或 Product.isHot（CHK-HOT-002）。
 * 投影列白名单只有 productId/categoryId/effectiveOrderCount/categoryPopulation。
 */
export function buildComputeAggregationSql(windowStart: Date, windowEnd: Date): Prisma.Sql {
  return Prisma.sql`
    WITH "counts" AS (
      SELECT "productId", COUNT(*)::int AS "effectiveOrderCount"
      FROM "Order"
      -- Prisma sends JavaScript Date raw parameters as timestamptz, while the
      -- legacy Order.createdAt column is timestamp without time zone. Convert
      -- the bound instants to UTC timestamps explicitly so the session TZ can
      -- never shift the frozen [windowStart, windowEnd) boundaries.
      WHERE "createdAt" >= (${windowStart}::timestamptz AT TIME ZONE 'UTC')
        AND "createdAt" < (${windowEnd}::timestamptz AT TIME ZONE 'UTC')
        AND "status" <> 'refunded'
      GROUP BY "productId"
    )
    SELECT
      a."id" AS "productId",
      a."categoryId" AS "categoryId",
      COALESCE(c."effectiveOrderCount", 0) AS "effectiveOrderCount",
      COUNT(*) OVER (PARTITION BY a."categoryId")::int AS "categoryPopulation"
    FROM "Product" a
    LEFT JOIN "counts" c ON c."productId" = a."id"
    WHERE a."status" = 'active'
  `
}

/** 单条排名结果（与 SnapshotInput 逐字段同形）。 */
export interface RankedSnapshot {
  productId: number
  categoryId: number
  effectiveOrderCount: number
  categoryRank: number
  categoryPopulation: number
  isHot: boolean
}

/**
 * 纯函数：category 内稳定排名 + Hot 阈值判定（D-MERCH-05 / AC-MERCH-004）。
 *
 * - 同分类内按 `effectiveOrderCount DESC, productId DESC` 排序 → 稳定 row number；
 * - `isHot = count >= minSales AND rank <= ceil(population * topPercent / 100)`；
 * - 防御性校验非负计数 / 非空 population / 合法 id（DB CHECK 之外的服务层兜底）。
 *
 * 不触 DB，可无数据库单元测试；输入顺序不影响结果（分组后按 categoryId ASC 输出）。
 */
export function computeCategoryRanks(
  rows: AggregationRow[],
  minSales: number,
  topPercent: number,
): RankedSnapshot[] {
  if (!Number.isInteger(minSales) || minSales < 1) {
    throw new Error(`invalid minSales ${String(minSales)} in ranking config`)
  }
  if (!Number.isInteger(topPercent) || topPercent < 1 || topPercent > 100) {
    throw new Error(`invalid topPercent ${String(topPercent)} in ranking config`)
  }
  const groups = new Map<number, AggregationRow[]>()
  for (const row of rows) {
    if (!Number.isInteger(row.productId) || row.productId <= 0) {
      throw new Error(`invalid productId ${String(row.productId)} in ranking aggregation`)
    }
    if (!Number.isInteger(row.categoryId) || row.categoryId <= 0) {
      throw new Error(`invalid categoryId ${String(row.categoryId)} in ranking aggregation`)
    }
    if (!Number.isInteger(row.effectiveOrderCount) || row.effectiveOrderCount < 0) {
      throw new Error(`invalid effectiveOrderCount ${String(row.effectiveOrderCount)} in ranking aggregation`)
    }
    if (!Number.isInteger(row.categoryPopulation) || row.categoryPopulation < 1) {
      throw new Error(`invalid categoryPopulation ${String(row.categoryPopulation)} in ranking aggregation`)
    }
    const list = groups.get(row.categoryId)
    if (list) list.push(row)
    else groups.set(row.categoryId, [row])
  }

  const snapshots: RankedSnapshot[] = []
  // 输出顺序确定：categoryId ASC（排名本身与输入顺序无关）。
  const categoryIds = [...groups.keys()].sort((a, b) => a - b)
  for (const categoryId of categoryIds) {
    const members = groups.get(categoryId)!
    // 同分类内 population 来自同一窗口 COUNT OVER，必须一致且等于本组行数；
    // 若 SQL/fixture 漏行则大声失败，避免用错误 denominator 发放 Hot 标签。
    const population = members[0].categoryPopulation
    if (members.some(member => member.categoryPopulation !== population) || population !== members.length) {
      throw new Error(`inconsistent categoryPopulation for categoryId ${categoryId}`)
    }
    const hotRankCutoff = Math.ceil((population * topPercent) / 100)
    // 冻结 tie-break：销量高者前，同销量按 productId 更大者前。
    const sorted = [...members].sort(
      (a, b) => b.effectiveOrderCount - a.effectiveOrderCount || b.productId - a.productId,
    )
    sorted.forEach((row, index) => {
      const categoryRank = index + 1
      snapshots.push({
        productId: row.productId,
        categoryId: row.categoryId,
        effectiveOrderCount: row.effectiveOrderCount,
        categoryRank,
        categoryPopulation: population,
        isHot: row.effectiveOrderCount >= minSales && categoryRank <= hotRankCutoff,
      })
    })
  }
  return snapshots
}

/**
 * BE-001 注入的真实 compute：事务 B 内部执行（repository.writeSnapshotsAndComplete）。
 * 抛错会让事务 B 整体回滚（无 partial snapshot）。
 */
export const computeRankingSnapshots: RunCompute = async (tx, ctx): Promise<SnapshotInput[]> => {
  const rows = await tx.$queryRaw<AggregationRow[]>(
    buildComputeAggregationSql(ctx.windowStart, ctx.windowEnd),
  )
  return computeCategoryRanks(rows, ctx.minSales, ctx.topPercent)
}

/**
 * 把真实 compute 注册到 BE-001 cron 的最小接线（T-MERCH-BE-002 owned）。
 *
 * 幂等：`setRankingCompute` 以最后一次注册为准，重复调用无副作用。调用方：
 * - 宿主 main 接线（CMI Integration Owner）import `ranking/index` 时，本模块入口
 *   已自动注册（见 index.ts），无需额外步骤；
 * - 测试/手动 recompute 可直接调用本函数显式注册。
 * 不得修改 global main（由 CMI 接线负责）。
 */
export function registerRankingCompute(): void {
  setRankingCompute(computeRankingSnapshots)
}
