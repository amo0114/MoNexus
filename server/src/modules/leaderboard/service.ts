import { performance } from 'node:perf_hooks'
import { Prisma } from '@prisma/client'
import {
  addCalendarDays,
  businessDateString,
  businessDayStartUtc,
  businessMonthStart,
  businessWeekStart,
} from '../../lib/businessTime.js'
import { maskEmail } from '../../lib/email.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import type {
  LeaderboardMe,
  LeaderboardPeriod,
  LeaderboardRefreshOutcome,
  LeaderboardResponse,
  LeaderboardScope,
} from './types.js'

/**
 * SPEC-LEADERBOARD-001 §4.3/§4.4。
 *
 * 写侧（refreshLeaderboards）每日一轮，把每期的**全量**合格得分用户落成
 * 快照；读侧（getLeaderboard）只查快照，不碰 PointLog。两侧共用
 * resolvePeriod / periodWindow，期边界只有一处定义。
 */

/** 与 fileAccess / sessionService 同形的日期状 advisory lock class。 */
const LEADERBOARD_LOCK_CLASS = 20260801
const TOP_LIMIT = 100
const TOTAL_PERIOD_KEY = 'ALL'
/** 全量快照写入是单事务，用户基数大时超过 Prisma 默认 5s。 */
const SNAPSHOT_TX_TIMEOUT_MS = 60_000

interface AggregateRow {
  userId: number
  /** PG bigint 聚合原样返回，不降级 number（精度守到快照层，序列化时再校验）。 */
  points: bigint
  lastEarnedAt: Date
}

/** 聚合可以跑在受控会话上（时区无关性回归用例注入 tx）。 */
type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>

/** 日历日所属的期。dateStr 必须是业务时区日历日（businessDateString 产物）。 */
export function resolvePeriod(scope: LeaderboardScope, dateStr: string): LeaderboardPeriod {
  if (scope === 'total') {
    return { scope, periodKey: TOTAL_PERIOD_KEY, startDay: null, endDay: null }
  }

  if (scope === 'month') {
    const startDay = businessMonthStart(dateStr)
    const [year, month] = startDay.split('-').map(Number)
    const endDay = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
    return { scope, periodKey: `M${startDay.slice(0, 7)}`, startDay, endDay }
  }

  // 周 key 用周一日历日而非 ISO 周号：ISO week-year 在跨年周会给出与日历
  // 年不一致的年份（2026-12-28 属 2027-W01），周一日期没有这个歧义。
  const startDay = businessWeekStart(dateStr)
  return { scope, periodKey: `W${startDay}`, startDay, endDay: addCalendarDays(startDay, 7) }
}

/**
 * LB-03：窗口 = [期首, min(期末次日, cutoff))，cutoff = 刷新当日北京 00:00
 * 的物理时刻（即数据截至昨日 24:00）。返回的 lastDay 是窗口覆盖到的最后
 * 一个日历日，也就是响应里的 dataThrough。
 */
function periodWindow(period: LeaderboardPeriod, cutoffDay: string) {
  const endDay = period.endDay !== null && period.endDay < cutoffDay ? period.endDay : cutoffDay
  return {
    startUtc: period.startDay === null ? null : businessDayStartUtc(period.startDay),
    endUtc: businessDayStartUtc(endDay),
    lastDay: addCalendarDays(endDay, -1),
  }
}

/**
 * LB-10：每轮覆盖当前三期，外加**最近一个已结束的**月榜与周榜。已结束期的
 * 窗口与流水都是确定的，重算幂等（LB-08），因此持续补刷而不是只在周期切换
 * 日补一次——边界日（1 日/周一）整天失败时，后续任何一轮都能把上一期最后
 * 一天的流水补进定格快照，不再产生永久缺口。
 */
export function refreshPeriods(today: string): LeaderboardPeriod[] {
  const periods = [
    resolvePeriod('total', today),
    resolvePeriod('month', today),
    resolvePeriod('week', today),
    // 结束月 = 本月 1 日的前一天所在月；结束周 = 本周一的前 7 天。
    resolvePeriod('month', addCalendarDays(businessMonthStart(today), -1)),
    resolvePeriod('week', addCalendarDays(businessWeekStart(today), -7)),
  ]
  // 按 scope + periodKey 去重并保持首现顺序（防御性：常规日期下结束期与
  // 当前期天然不重合，但集合必须始终是安全输入）。
  const seen = new Set<string>()
  return periods.filter(period => {
    const key = `${period.scope}:${period.periodKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 窗口边界的绑定形式。
 *
 * `PointLog.createdAt` 是 `timestamp(3) without time zone`，Prisma 往里写的是
 * **裸 UTC 时刻**；而 $queryRaw 把 JS Date 绑成 `timestamptz`。两者直接比较
 * 时 PG 会把裸列按**会话时区**重新解释（本机 PG 会话就是 Asia/Shanghai），
 * 整个窗口偏移 8 小时——更麻烦的是它在 UTC 会话下不显形，只在中国时区的
 * 库上出错。`AT TIME ZONE 'UTC'` 把参数换算成与存储同形的裸 UTC 时刻；左侧
 * 保持裸列，(type, createdAt) 索引照常可用。
 *
 * dashboard/service.ts 的月边界同时踩了这一条和 host-local Date 运算，两个
 * 错误在 +0800 主机上互相抵消——不要照抄那种写法（LB-11）。
 */
function boundAsStoredUtc(instant: Date) {
  return Prisma.sql`${instant}::timestamptz AT TIME ZONE 'UTC'`
}

/**
 * LB-01：口径与 memberTier.ts computeLifetimeEarnedPoints 字面一致——
 * SUM(amount) WHERE type='in' AND amount > 0，out/hold/release/refund 一律
 * 不计。**两处修改必须同步**，否则总榜与会员等级会给出两个"累计获得"。
 * `amount > 0` 排除非正流水：零额 'in'（如奖励配置为 0）不该造出 0 分榜单行。
 *
 * SUM(int) 返回 PG bigint，聚合全程不 cast 成 int4——单用户积分超过
 * 2^31-1 时旧写法会让整轮刷新直接溢出崩掉。
 *
 * LB-04 的全序（points desc → 窗口内最后一笔 in 的 createdAt asc → userId
 * asc）直接由 SQL 定序，rank 就是结果集下标，可重跑复现。
 */
async function aggregateWindow(
  startUtc: Date | null,
  endUtc: Date,
  client: RawClient = prisma
): Promise<AggregateRow[]> {
  const lowerBound =
    startUtc === null ? Prisma.empty : Prisma.sql`AND pl."createdAt" >= ${boundAsStoredUtc(startUtc)}`

  return client.$queryRaw<AggregateRow[]>`
    SELECT
      pl."userId" AS "userId",
      SUM(pl."amount") AS "points",
      MAX(pl."createdAt") AS "lastEarnedAt"
    FROM "PointLog" pl
    INNER JOIN "User" u ON u."id" = pl."userId"
    WHERE pl."type" = 'in'
      AND pl."amount" > 0
      AND pl."createdAt" < ${boundAsStoredUtc(endUtc)}
      ${lowerBound}
      AND u."role" <> 'admin'
      AND u."status" <> '已封禁'
    GROUP BY pl."userId"
    ORDER BY SUM(pl."amount") DESC, MAX(pl."createdAt") ASC, pl."userId" ASC
  `
}

/**
 * 仅供「窗口边界不随 PG 会话时区漂移」回归用例：在 SET LOCAL TIME ZONE 的
 * 事务里跑**同一条**聚合，而不是在测试里复制一份 SQL。
 */
export const __aggregateWindowForTests = aggregateWindow

/**
 * API 契约保持 number（前端 zod/类型不变）。bigint → number 只在 JS 安全整数
 * 范围内放行；超出说明积分体系被异常写穿（正常业务不可达），读侧显式失败并
 * 记录，绝不静默丢精度——快照层仍保有精确 bigint，修复后重刷即可恢复。
 */
function pointsToApiNumber(value: bigint): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) {
    logger.error(
      { op: 'leaderboard.points-overflow', points: value.toString() },
      'leaderboard points exceed JS safe integer range; refusing lossy serialization'
    )
    throw new Error('LEADERBOARD_POINTS_OVERFLOW')
  }
  return n
}

/**
 * LB-08：快照替换在单事务内 delete + createMany，MVCC 保证读侧任意时刻
 * 只见完整的旧份或新份。advisory lock 按 (scope, periodKey) 串行化——租约
 * 允许「互斥丢失后继续跑」，同期两轮并发才不会撞 unique 约束。
 *
 * 名次变化（P3-1）：替换前把旧份 userId→rank 读出，新行 prevRank 即上一轮
 * 名次（新入榜为 null）。同一事务内先读后删，前后两份绝不会互相看见半成品。
 */
async function replaceSnapshot(period: LeaderboardPeriod, rows: AggregateRow[], computedAt: Date) {
  const lockKey = `${period.scope}:${period.periodKey}`
  await prisma.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEADERBOARD_LOCK_CLASS}::int4, hashtext(${lockKey}))`
      const previous = await tx.leaderboardEntry.findMany({
        where: { scope: period.scope, periodKey: period.periodKey },
        select: { userId: true, rank: true },
      })
      const prevRankOf = new Map(previous.map(row => [row.userId, row.rank]))
      await tx.leaderboardEntry.deleteMany({ where: { scope: period.scope, periodKey: period.periodKey } })
      if (rows.length === 0) return
      await tx.leaderboardEntry.createMany({
        data: rows.map((row, index) => ({
          scope: period.scope,
          periodKey: period.periodKey,
          rank: index + 1,
          userId: row.userId,
          points: row.points,
          computedAt,
          prevRank: prevRankOf.get(row.userId) ?? null,
        })),
      })
    },
    { timeout: SNAPSHOT_TX_TIMEOUT_MS }
  )
}

/**
 * 一轮刷新。`now` 可注入：cutoff 与期集合全部由它推导，测试不依赖宿主
 * 时钟（CI 是 UTC、开发机 +0800，两边必须同结果）。
 */
export async function refreshLeaderboards({
  now = new Date(),
}: { now?: Date } = {}): Promise<LeaderboardRefreshOutcome[]> {
  const startedAt = performance.now()
  const today = businessDateString(now)
  const outcomes: LeaderboardRefreshOutcome[] = []

  for (const period of refreshPeriods(today)) {
    const { startUtc, endUtc } = periodWindow(period, today)
    const rows = await aggregateWindow(startUtc, endUtc)
    await replaceSnapshot(period, rows, now)
    outcomes.push({ scope: period.scope, periodKey: period.periodKey, entryCount: rows.length })
  }

  logger.info({
    op: 'leaderboard.refresh',
    today,
    periods: outcomes,
    duration_ms: Math.round(performance.now() - startedAt),
  })
  return outcomes
}

/**
 * LB-07：展示名口径与 reviews/service.ts 的 displayNameFor 一致（昵称去空白，
 * 空则回退打码邮箱）。**两处修改必须同步**——它同时是评价区和榜单的对外身份。
 */
async function displayNamesFor(userIds: number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map()
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, nickname: true, email: true },
  })
  return new Map(users.map(user => [user.id, user.nickname?.trim() || maskEmail(user.email)]))
}

function periodLabel(period: LeaderboardPeriod): string {
  if (period.scope === 'total') return '全部'
  if (period.scope === 'month') {
    const [year, month] = period.startDay!.split('-').map(Number)
    return `${year}年${month}月`
  }
  return `${period.startDay!.slice(5)} ~ ${addCalendarDays(period.startDay!, 6).slice(5)}`
}

/**
 * 读侧：当前期的 Top 100 + 请求者自己的名次。
 *
 * 一期的行同批写入、共享 computedAt，所以 updatedAt 取首行即可；本期无行时
 * 回退到总榜的 computedAt（总榜每轮必刷），把「新周期首日」与「部署后首刷
 * 空窗」(C12，updatedAt null) 区分开。dataThrough 由 computedAt 反推而非由
 * now 反推——cron 落后时不能谎称数据比实际更新。
 */
export async function getLeaderboard(
  scope: LeaderboardScope,
  userId: number,
  { now = new Date() }: { now?: Date } = {}
): Promise<LeaderboardResponse> {
  const startedAt = performance.now()
  const period = resolvePeriod(scope, businessDateString(now))
  const where = { scope, periodKey: period.periodKey }

  const [topRows, myRow] = await Promise.all([
    prisma.leaderboardEntry.findMany({
      where,
      orderBy: { rank: 'asc' },
      take: TOP_LIMIT,
      select: { rank: true, userId: true, points: true, computedAt: true, prevRank: true },
    }),
    prisma.leaderboardEntry.findUnique({
      where: { scope_periodKey_userId: { ...where, userId } },
      select: { rank: true, points: true, prevRank: true },
    }),
  ])

  let computedAt: Date | null = topRows[0]?.computedAt ?? null
  // 空期快照没有行可携带 computedAt，若停在 null，前端会把「新周期首日、
  // 本期确无数据」误判成「部署后首刷空窗」(C12)。总榜每轮必刷，用它的
  // computedAt 兜底：updatedAt 为 null 从此严格等价于「系统尚无任何快照」。
  if (computedAt === null && scope !== 'total') {
    const totalRow = await prisma.leaderboardEntry.findFirst({
      where: { scope: 'total', periodKey: TOTAL_PERIOD_KEY },
      select: { computedAt: true },
    })
    computedAt = totalRow?.computedAt ?? null
  }
  const names = await displayNamesFor(topRows.map(row => row.userId))
  const me: LeaderboardMe | null =
    myRow === null
      ? null
      : { rank: myRow.rank, points: pointsToApiNumber(myRow.points), prevRank: myRow.prevRank }

  const result: LeaderboardResponse = {
    scope,
    periodKey: period.periodKey,
    periodLabel: periodLabel(period),
    dataThrough: computedAt === null ? null : periodWindow(period, businessDateString(computedAt)).lastDay,
    updatedAt: computedAt === null ? null : computedAt.toISOString(),
    top: topRows.map(row => ({
      rank: row.rank,
      displayName: names.get(row.userId) ?? '',
      points: pointsToApiNumber(row.points),
      isMe: row.userId === userId,
      prevRank: row.prevRank,
    })),
    me,
  }

  logger.info({
    op: 'leaderboard.get',
    scope,
    periodKey: period.periodKey,
    rows: result.top.length,
    duration_ms: Math.round(performance.now() - startedAt),
  })
  return result
}
