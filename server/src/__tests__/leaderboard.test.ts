import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCalendarDays,
  businessDateString,
  businessDayStartUtc,
  businessMonthStart,
  businessWeekStart,
} from '../lib/businessTime.js'
import { acquireCronLeaseWithHeartbeat } from '../lib/cronLease.js'
import { maskEmail } from '../lib/email.js'
import { computeLifetimeEarnedPoints } from '../lib/memberTier.js'
import { prisma } from '../lib/prisma.js'
import {
  LEADERBOARD_REFRESH_WINDOW_MS,
  runLeaderboardRefreshCronBatch,
} from '../modules/leaderboard/cron.js'
import { LeaderboardResponseSchema } from '../modules/leaderboard/schemas.js'
import {
  __aggregateWindowForTests,
  getLeaderboard,
  refreshLeaderboards,
  refreshPeriods,
  resolvePeriod,
} from '../modules/leaderboard/service.js'
import type { LeaderboardScope } from '../modules/leaderboard/types.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

/**
 * SPEC-LEADERBOARD-001 A.6：性质 P.1–P.8 + 验收 1–6。
 *
 * 时钟纪律（C15）：所有服务层用例注入 `now`，期望值由 businessTime helper
 * 推导，绝不读宿主时钟、不 setSystemTime——CI 跑 UTC、开发机跑 +0800，
 * 两边必须同结果。造数的 createdAt 一律写显式 `+08:00` 偏移量。
 */

const PASSWORD = 'pass123'
/** 2026-05-20 是周三：所在周一 2026-05-18，所在月 2026-05。 */
const REF_DAY = '2026-05-20'
const REF_NOW = at(REF_DAY, '06:00:00')
const MONTH_KEY = 'M2026-05'
const WEEK_KEY = 'W2026-05-18'

/** 北京时区某日某时刻的物理时刻。 */
function at(day: string, time = '12:00:00') {
  return new Date(`${day}T${time}+08:00`)
}

async function makeUser(
  email: string,
  opts: { role?: 'user' | 'admin' | 'merchant'; status?: string; nickname?: string } = {}
) {
  const { user } = await createTestUser(email, PASSWORD, opts.role ?? 'user', 0)
  // helper 会补一条初始 'in' 流水（金额 0，createdAt = 此刻）；榜单造数要求
  // 每一笔流水的时刻都由用例指定，先清干净。
  await prisma.pointLog.deleteMany({ where: { userId: user.id } })
  if (opts.status !== undefined || opts.nickname !== undefined) {
    return prisma.user.update({
      where: { id: user.id },
      data: { status: opts.status, nickname: opts.nickname },
    })
  }
  return user
}

async function log(userId: number, type: string, amount: number, when: Date) {
  await prisma.pointLog.create({
    data: { userId, type, amount, balanceAfter: 0, reason: '排行榜测试流水', createdAt: when },
  })
}

const earn = (userId: number, amount: number, when: Date) => log(userId, 'in', amount, when)

function snapshotRows(scope: LeaderboardScope, periodKey: string) {
  return prisma.leaderboardEntry.findMany({
    where: { scope, periodKey },
    orderBy: { rank: 'asc' },
    select: { rank: true, userId: true, points: true, computedAt: true },
  })
}

async function pointsOf(scope: LeaderboardScope, periodKey: string, userId: number) {
  const row = await prisma.leaderboardEntry.findUnique({
    where: { scope_periodKey_userId: { scope, periodKey, userId } },
    select: { points: true },
  })
  return row?.points ?? null
}

describe('leaderboard refresh — 计分口径 (P.1, 验收 1-2)', () => {
  it('总榜积分等于 computeLifetimeEarnedPoints；out/hold/release/refund 一律不计', async () => {
    const user = await makeUser('lb-scope@test.local')
    await earn(user.id, 100, at('2026-05-10'))
    await earn(user.id, 200, at('2026-05-12'))
    for (const type of ['out', 'hold', 'release', 'refund']) {
      await log(user.id, type, 500, at('2026-05-11'))
    }

    await refreshLeaderboards({ now: REF_NOW })

    expect(await pointsOf('total', 'ALL', user.id)).toBe(300)
    // 验收 1：与会员等级 lifetime earned 是同一个数字。
    expect(await pointsOf('total', 'ALL', user.id)).toBe(await computeLifetimeEarnedPoints(user.id))
    // 验收 2：非 'in' 流水对月/周榜同样零影响。
    expect(await pointsOf('month', MONTH_KEY, user.id)).toBe(300)
    // 本周窗口是 [05-18, 05-20)，这些流水都在窗口之前 → 不入周榜（LB-06）。
    expect(await pointsOf('week', WEEK_KEY, user.id)).toBeNull()
  })

  it('随机五类流水混合下，逐用户仍恒等于 lifetime earned（无 in 者不入榜，LB-06）', async () => {
    const users = []
    for (let i = 0; i < 5; i++) users.push(await makeUser(`lb-rand-${i}@test.local`))

    // 固定种子的伪随机：失败可原样复现。
    let seed = 20260801
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const types = ['in', 'out', 'hold', 'release', 'refund']
    for (let i = 0; i < 60; i++) {
      const user = users[Math.floor(rand() * users.length)]
      const type = types[Math.floor(rand() * types.length)]
      const amount = 1 + Math.floor(rand() * 500)
      const day = addCalendarDays('2026-05-01', Math.floor(rand() * 19))
      await log(user.id, type, amount, at(day))
    }

    await refreshLeaderboards({ now: REF_NOW })

    for (const user of users) {
      const lifetime = await computeLifetimeEarnedPoints(user.id)
      // 无 'in' 流水 → 无快照行（LB-06），与 lifetime 0 对应。
      expect(await pointsOf('total', 'ALL', user.id) ?? 0).toBe(lifetime)
    }
  })
})

describe('leaderboard refresh — 窗口封闭 (P.2, LB-03)', () => {
  it('月/周边界与 cutoff ±1 秒的流水恰好落入正确周期', async () => {
    const user = await makeUser('lb-window@test.local')
    const monthStart = businessDayStartUtc(businessMonthStart(REF_DAY))
    const weekStart = businessDayStartUtc(businessWeekStart(REF_DAY))
    const cutoff = businessDayStartUtc(REF_DAY)

    await earn(user.id, 1, new Date(monthStart.getTime() - 1000)) // 上月最后一秒
    await earn(user.id, 2, monthStart) // 本月第一秒
    await earn(user.id, 4, new Date(weekStart.getTime() - 1000)) // 上周最后一秒
    await earn(user.id, 8, weekStart) // 本周第一秒
    await earn(user.id, 16, new Date(cutoff.getTime() - 1000)) // 昨日最后一秒
    await earn(user.id, 32, cutoff) // 今日第一秒 —— cutoff 右开，全部排除

    await refreshLeaderboards({ now: REF_NOW })

    expect(await pointsOf('total', 'ALL', user.id)).toBe(1 + 2 + 4 + 8 + 16)
    expect(await pointsOf('month', MONTH_KEY, user.id)).toBe(2 + 4 + 8 + 16)
    expect(await pointsOf('week', WEEK_KEY, user.id)).toBe(8 + 16)
  })

  it('周期 key 由业务时区日历日决定，与刷新发生在当日哪个时刻无关', async () => {
    const user = await makeUser('lb-key@test.local')
    await earn(user.id, 42, at('2026-05-19'))

    // 北京 00:00:01 与 23:59:59 是同一个业务日，必须落进同一份快照。
    await refreshLeaderboards({ now: at(REF_DAY, '00:00:01') })
    const early = await snapshotRows('week', WEEK_KEY)
    await refreshLeaderboards({ now: at(REF_DAY, '23:59:59') })
    const late = await snapshotRows('week', WEEK_KEY)

    expect(early.map(r => r.points)).toEqual([42])
    expect(late.map(r => r.points)).toEqual([42])
  })

  it('窗口边界不随 PG 会话时区漂移', async () => {
    // 回归：createdAt 是 timestamp without time zone（裸 UTC），$queryRaw 把
    // JS Date 绑成 timestamptz。若直接裸比较，PG 会按**会话时区**重新解释裸
    // 列——本机 PG 会话是 Asia/Shanghai，窗口整体偏 8 小时；而 CI 若是 UTC
    // 会话则完全不显形。三个时区跑同一条聚合，结果必须逐字节一致。
    const user = await makeUser('lb-session-tz@test.local')
    const cutoff = businessDayStartUtc(REF_DAY)
    await earn(user.id, 5, new Date(cutoff.getTime() - 1000)) // 昨日最后一秒 → 计入
    await earn(user.id, 7, cutoff) // 今日第一秒 → 排除

    for (const timeZone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      const rows = await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`)
        return __aggregateWindowForTests(null, cutoff, tx)
      })
      expect(rows.map(row => ({ userId: row.userId, points: row.points }))).toEqual([
        { userId: user.id, points: 5 },
      ])
    }
  })
})

describe('leaderboard refresh — 排名全序与幂等 (P.3, LB-04/LB-08)', () => {
  it('并列按「先达到者靠前 → userId 升序」定序，rank 连续无洞，重跑逐行一致', async () => {
    const top = await makeUser('lb-rank-top@test.local')
    const early = await makeUser('lb-rank-early@test.local')
    const late = await makeUser('lb-rank-late@test.local')
    const tieA = await makeUser('lb-rank-tie-a@test.local')
    const tieB = await makeUser('lb-rank-tie-b@test.local')

    await earn(top.id, 500, at('2026-05-15'))
    // 同为 300 分：early 更早达到 → 排在 late 前面。
    await earn(early.id, 300, at('2026-05-10'))
    await earn(late.id, 300, at('2026-05-12'))
    // 同分且最后一笔时刻完全相同 → userId 升序。
    const sameInstant = at('2026-05-11', '08:30:00')
    await earn(tieA.id, 100, sameInstant)
    await earn(tieB.id, 100, sameInstant)

    await refreshLeaderboards({ now: REF_NOW })
    const first = await snapshotRows('total', 'ALL')

    expect(first.map(r => r.rank)).toEqual([1, 2, 3, 4, 5])
    expect(first.map(r => r.userId)).toEqual([top.id, early.id, late.id, tieA.id, tieB.id])
    expect(tieA.id).toBeLessThan(tieB.id)

    await refreshLeaderboards({ now: REF_NOW })
    const second = await snapshotRows('total', 'ALL')
    expect(second.map(({ rank, userId, points }) => ({ rank, userId, points }))).toEqual(
      first.map(({ rank, userId, points }) => ({ rank, userId, points }))
    )
  })
})

describe('leaderboard refresh — 名次变化投影 prevRank (P3-1)', () => {
  it('新一轮把上一轮 rank 写入 prevRank；新入榜为 null；读侧随行下发', async () => {
    const a = await makeUser('lb-delta-a@test.local')
    const b = await makeUser('lb-delta-b@test.local')

    await earn(a.id, 100, at('2026-05-18'))
    await earn(b.id, 50, at('2026-05-18'))
    await refreshLeaderboards({ now: at('2026-05-19', '06:00:00') })

    // 首轮：没有上一轮，prevRank 全 null。
    const first = await prisma.leaderboardEntry.findMany({
      where: { scope: 'total', periodKey: 'ALL' },
      orderBy: { rank: 'asc' },
      select: { userId: true, rank: true, prevRank: true },
    })
    expect(first.map(r => r.prevRank)).toEqual([null, null])

    // 次日 B 反超、C 新入榜：prevRank 记录上一轮名次。
    await earn(b.id, 200, at('2026-05-19'))
    const c = await makeUser('lb-delta-c@test.local')
    await earn(c.id, 10, at('2026-05-19'))
    await refreshLeaderboards({ now: REF_NOW })

    const second = await prisma.leaderboardEntry.findMany({
      where: { scope: 'total', periodKey: 'ALL' },
      orderBy: { rank: 'asc' },
      select: { userId: true, rank: true, prevRank: true },
    })
    expect(second).toEqual([
      { userId: b.id, rank: 1, prevRank: 2 },
      { userId: a.id, rank: 2, prevRank: 1 },
      { userId: c.id, rank: 3, prevRank: null },
    ])

    // 读侧：top 行与 me 都带 prevRank（schema 已含白名单字段）。
    const token = (await loginAs('lb-delta-b@test.local', PASSWORD)).accessToken
    const res = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    expect(res.body.top[0]).toMatchObject({ rank: 1, prevRank: 2, isMe: true })
    expect(res.body.me).toEqual({ rank: 1, points: 250, prevRank: 2 })
  })
})

describe('leaderboard refresh — 资格投影 (P.4, LB-05, 验收 4)', () => {
  it('admin 与封禁用户不入任何榜且 me 恒 null；merchant 正常入榜', async () => {
    const admin = await makeUser('lb-elig-admin@test.local', { role: 'admin' })
    const banned = await makeUser('lb-elig-banned@test.local', { status: '已封禁' })
    const merchant = await makeUser('lb-elig-merchant@test.local', { role: 'merchant' })
    const buyer = await makeUser('lb-elig-buyer@test.local')
    for (const user of [admin, banned, merchant, buyer]) await earn(user.id, 900, at('2026-05-15'))

    await refreshLeaderboards({ now: REF_NOW })

    for (const [scope, periodKey] of [
      ['total', 'ALL'],
      ['month', MONTH_KEY],
      ['week', WEEK_KEY],
    ] as const) {
      const ids = (await snapshotRows(scope, periodKey)).map(r => r.userId)
      // week 窗口是 [05-18, 05-20)，05-15 的流水不在内——三榜都必须只由
      // 资格决定谁"可以"出现，week 恰好为空正说明窗口与资格是两件事。
      if (scope === 'week') {
        expect(ids).toEqual([])
        continue
      }
      expect(ids).not.toContain(admin.id)
      expect(ids).not.toContain(banned.id)
      expect(ids).toContain(merchant.id)
      expect(ids).toContain(buyer.id)
    }

    expect((await getLeaderboard('total', admin.id, { now: REF_NOW })).me).toBeNull()
    expect((await getLeaderboard('total', banned.id, { now: REF_NOW })).me).toBeNull()
    expect((await getLeaderboard('total', merchant.id, { now: REF_NOW })).me).not.toBeNull()
  })
})

describe('leaderboard refresh — 周期定格 (P.5, LB-10, 验收 3)', () => {
  it('每月 1 日补刷上月：定格快照含 31 日流水，本月榜空态', async () => {
    const user = await makeUser('lb-freeze-month@test.local')
    await earn(user.id, 100, at('2026-05-15'))
    await earn(user.id, 50, at('2026-05-31', '23:30:00'))

    // 5-31 当天：本月窗口右边界 = 5-31 00:00，最后一天的流水还进不来。
    await refreshLeaderboards({ now: at('2026-05-31', '10:00:00') })
    expect(await pointsOf('month', MONTH_KEY, user.id)).toBe(100)

    // 6-1：补刷上月，窗口右边界 = 6-1 00:00 → 含 5-31 全天。
    await refreshLeaderboards({ now: at('2026-06-01', '00:30:00') })
    expect(await pointsOf('month', MONTH_KEY, user.id)).toBe(150)

    // 新周期首日窗口 [6-1, 6-1) 为空 → 本月榜空态（C7）。
    expect(await snapshotRows('month', 'M2026-06')).toEqual([])
  })

  it('月初整天失败后，之后任一轮仍能补齐上月定格快照（LB-10 持续补刷）', async () => {
    const user = await makeUser('lb-freeze-recovery@test.local')
    await earn(user.id, 100, at('2026-05-15'))
    await earn(user.id, 50, at('2026-05-31', '23:30:00'))

    // 5-31 最后一次成功刷新：本月窗口不含 31 日。
    await refreshLeaderboards({ now: at('2026-05-31', '10:00:00') })
    expect(await pointsOf('month', MONTH_KEY, user.id)).toBe(100)

    // 6-1 整天失败（cron 宕机，无任何成功刷新）——直接跳到 6-2。
    await earn(user.id, 999, at('2026-06-01', '09:00:00'))
    await refreshLeaderboards({ now: at('2026-06-02', '03:00:00') })

    // 上月虽已不在「当前期」，仍在刷新集合内 → 31 日流水被补齐；
    // 6-1 的流水归属 6 月榜，不泄漏进 5 月窗口。
    expect(await pointsOf('month', MONTH_KEY, user.id)).toBe(150)
    expect(await pointsOf('month', 'M2026-06', user.id)).toBe(999)
  })

  it('每周一补刷上周：定格快照含周日流水，本周榜为空态', async () => {
    const user = await makeUser('lb-freeze-week@test.local')
    await earn(user.id, 100, at('2026-05-20'))
    await earn(user.id, 70, at('2026-05-24', '22:00:00')) // 周日晚

    await refreshLeaderboards({ now: at('2026-05-24', '09:00:00') })
    expect(await pointsOf('week', WEEK_KEY, user.id)).toBe(100)

    // 2026-05-25 是周一（且不是月初，与月补刷相互独立）。
    await refreshLeaderboards({ now: at('2026-05-25', '00:20:00') })
    expect(await pointsOf('week', WEEK_KEY, user.id)).toBe(170)
    expect(await snapshotRows('week', 'W2026-05-25')).toEqual([])
  })
})

describe('refreshPeriods — 刷新集合 (LB-10 持续补刷)', () => {
  it('常规日也包含最近一个已结束的月/周榜，且按 scope+periodKey 去重', () => {
    // 2026-05-20 周三：当前月 2026-05、当前周 W2026-05-18；结束期 2026-04 / W2026-05-11。
    const periods = refreshPeriods('2026-05-20')
    const keys = periods.map(p => `${p.scope}:${p.periodKey}`)
    expect(keys).toEqual([
      'total:ALL',
      'month:M2026-05',
      'week:W2026-05-18',
      'month:M2026-04',
      'week:W2026-05-11',
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('周期切换日（1 日恰为周一）当前期与结束期不重合、无重复', () => {
    // 2026-06-01 是周一。
    const periods = refreshPeriods('2026-06-01')
    const keys = periods.map(p => `${p.scope}:${p.periodKey}`)
    expect(keys).toEqual([
      'total:ALL',
      'month:M2026-06',
      'week:W2026-06-01',
      'month:M2026-05',
      'week:W2026-05-25',
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('leaderboard refresh — 事务原子性 (P.7)', () => {
  it('替换事务中途失败时回滚，旧快照完整保留', async () => {
    const user = await makeUser('lb-atomic@test.local')
    await earn(user.id, 100, at('2026-05-10'))
    await refreshLeaderboards({ now: REF_NOW })
    const before = await snapshotRows('total', 'ALL')
    expect(before).toHaveLength(1)

    // 让 INSERT 在事务中途炸掉——DB 级失败，不依赖 mock 内部实现。
    await prisma.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION lb_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lb boom'; END; $$"
    )
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER lb_test_boom BEFORE INSERT ON "LeaderboardEntry" FOR EACH ROW EXECUTE FUNCTION lb_test_boom()'
    )
    try {
      // 新流水本应改写快照；事务失败后它一行也不能落地。
      await earn(user.id, 999, at('2026-05-11'))
      await expect(refreshLeaderboards({ now: REF_NOW })).rejects.toThrow()
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS lb_test_boom ON "LeaderboardEntry"')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS lb_test_boom()')
    }

    // delete 与 createMany 同生共死：旧份完好，没有"删了没写"的中间态。
    expect(await snapshotRows('total', 'ALL')).toEqual(before)
  })
})

describe('leaderboard cron — 租约互斥 (P.8, LB-09, 验收 6)', () => {
  beforeEach(async () => {
    // CronLease 不在 setup.ts 的清库列表里，用例自己收尾。
    await prisma.cronLease.deleteMany({ where: { name: 'leaderboard-refresh' } })
  })

  it('舰队并发领取恰一方胜出，且 24h 窗口内不再放行第二轮', async () => {
    const handles = await Promise.all(
      Array.from({ length: 4 }, () =>
        acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS, { force: true })
      )
    )
    const winners = handles.filter(Boolean)
    expect(winners).toHaveLength(1)

    winners[0]!.release()
    // 互斥已释放，但窗口节流仍在 → 每日至多一轮快照。
    expect(
      await acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS, { force: true })
    ).toBeNull()
  })

  it('同进程重入被 running 标志挡下', async () => {
    const [a, b] = await Promise.all([runLeaderboardRefreshCronBatch(), runLeaderboardRefreshCronBatch()])
    expect([a.length > 0, b.length > 0].filter(Boolean)).toHaveLength(1)
  })

  it('失败回拨（releaseForRetry）：下一 tick 可立即重新领取；普通释放仍受窗口节流', async () => {
    const first = await acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS, {
      force: true,
    })
    expect(first).not.toBeNull()
    // 失败路径：回拨窗口后互斥与节流同时解除。
    await first!.releaseForRetry()

    const second = await acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS, {
      force: true,
    })
    expect(second).not.toBeNull()

    // 成功路径不受影响：普通 release 后 24h 窗口节流照常拒绝下一轮。
    second!.release()
    await expect(
      acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS, { force: true })
    ).resolves.toBeNull()
  })

  it('旧 token 不能释放或回拨新持有者的租约', async () => {
    const first = await acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS, {
      force: true,
    })
    expect(first).not.toBeNull()

    // 模拟互斥 TTL 过期后被其他实例接管：token/lockedUntil/lastStartedAt 全部易主。
    await prisma.$executeRaw`
      UPDATE "CronLease"
      SET "leaseToken" = 'taken-over-holder',
          "lockedUntil" = now() + make_interval(secs => 90),
          "lastStartedAt" = now()
      WHERE "name" = 'leaderboard-refresh'`

    await first!.releaseForRetry()

    const row = await prisma.cronLease.findUnique({ where: { name: 'leaderboard-refresh' } })
    expect(row!.leaseToken).toBe('taken-over-holder')
    // 新持有者的互斥未被释放（lockedUntil 仍在一分钟后），节流窗口未被回拨。
    expect(row!.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 60_000)
    expect(row!.lastStartedAt.getTime()).toBeGreaterThan(Date.now() - 10_000)
  })
})

describe('GET /api/leaderboard', () => {
  /** 直接落快照：读侧契约与 cron 窗口语义解耦，用例不依赖真实日期。 */
  async function seedSnapshot(
    scope: LeaderboardScope,
    entries: Array<{ userId: number; points: number }>,
    computedAt = new Date()
  ) {
    const period = resolvePeriod(scope, businessDateString(computedAt))
    await prisma.leaderboardEntry.createMany({
      data: entries.map((entry, index) => ({
        scope,
        periodKey: period.periodKey,
        rank: index + 1,
        userId: entry.userId,
        points: entry.points,
        computedAt,
      })),
    })
    return period
  }

  function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys))
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key)
        collectKeys(child, keys)
      }
    }
    return keys
  }

  it('匿名请求 → 401', async () => {
    await api.get('/api/leaderboard').expect(401)
  })

  it('封禁用户 → 403（requireActiveUser 先于业务逻辑）', async () => {
    await createTestUser('lb-api-admin@test.local', 'admin123', 'admin')
    const { user } = await createTestUser('lb-api-banned@test.local', PASSWORD, 'user', 0)
    const victim = await loginAs('lb-api-banned@test.local', PASSWORD)
    const admin = await loginAs('lb-api-admin@test.local', 'admin123')
    await api
      .put(`/api/admin/users/${user.id}/ban`)
      .set(authHeader(admin.accessToken))
      .send({ reason: '排行榜鉴权矩阵' })
      .expect(200)

    const res = await api.get('/api/leaderboard').set(authHeader(victim.accessToken)).expect(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('缺省 scope 为 total；三个 scope 各自回对应 periodKey 与 periodLabel', async () => {
    await makeUser('lb-api-scope@test.local')
    const token = (await loginAs('lb-api-scope@test.local', PASSWORD)).accessToken
    const today = businessDateString(new Date())

    const omitted = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    expect(omitted.body.scope).toBe('total')
    expect(omitted.body.periodKey).toBe('ALL')
    expect(omitted.body.periodLabel).toBe('全部')

    for (const scope of ['total', 'month', 'week'] as const) {
      const res = await api.get('/api/leaderboard').query({ scope }).set(authHeader(token)).expect(200)
      expect(res.body.scope).toBe(scope)
      expect(res.body.periodKey).toBe(resolvePeriod(scope, today).periodKey)
      expect(LeaderboardResponseSchema.safeParse(res.body).success).toBe(true)
    }
  })

  it('非法 scope → 400 VALIDATION_ERROR', async () => {
    await makeUser('lb-api-bad-scope@test.local')
    const token = (await loginAs('lb-api-bad-scope@test.local', PASSWORD)).accessToken

    const res = await api
      .get('/api/leaderboard')
      .query({ scope: 'yearly' })
      .set(authHeader(token))
      .expect(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('尚无快照时回空窗契约：top []、updatedAt/dataThrough 均为 null (C12)', async () => {
    await makeUser('lb-api-empty@test.local')
    const token = (await loginAs('lb-api-empty@test.local', PASSWORD)).accessToken

    const res = await api.get('/api/leaderboard').query({ scope: 'week' }).set(authHeader(token)).expect(200)
    expect(res.body.top).toEqual([])
    expect(res.body.me).toBeNull()
    expect(res.body.updatedAt).toBeNull()
    expect(res.body.dataThrough).toBeNull()
    expect(LeaderboardResponseSchema.safeParse(res.body).success).toBe(true)
  })

  it('新周期首日：本期无行时 updatedAt 回退总榜批次，与首刷空窗可区分', async () => {
    // 顺序有讲究：requireActiveUser 的 60s 状态缓存按 userId 记忆且测试间
    // 不清空，而 TRUNCATE ... RESTART IDENTITY 会复用自增 id——封禁用例把
    // id=2 缓存成了已封禁，所以真正调 API 的 viewer 必须先建（占 id=1）。
    await makeUser('lb-api-fresh-viewer@test.local')
    const someone = await makeUser('lb-api-fresh-period@test.local')
    const token = (await loginAs('lb-api-fresh-viewer@test.local', PASSWORD)).accessToken
    const computedAt = new Date()
    await seedSnapshot('total', [{ userId: someone.id, points: 100 }], computedAt)

    const res = await api.get('/api/leaderboard').query({ scope: 'week' }).set(authHeader(token)).expect(200)
    expect(res.body.top).toEqual([])
    expect(res.body.me).toBeNull()
    // 刷新已经跑过（总榜携带批次时刻），本期只是还没有数据——不是 C12 空窗，
    // 前端要据此显示「新的一周刚开始」而非「榜单正在生成中」。
    expect(res.body.updatedAt).toBe(computedAt.toISOString())
    expect(res.body.dataThrough).toBe(addCalendarDays(businessDateString(computedAt), -1))
    expect(LeaderboardResponseSchema.safeParse(res.body).success).toBe(true)
  })

  it('top 截断到 100 条，rank 连续；me 即使排在 100 名开外也精确返回 (C6)', async () => {
    const me = await makeUser('lb-api-top@test.local')
    const token = (await loginAs('lb-api-top@test.local', PASSWORD)).accessToken
    // 榜上其余人不登录，直接建行（跳过 bcrypt）。
    await prisma.user.createMany({
      data: Array.from({ length: 104 }, (_, i) => ({
        email: `lb-bulk-${i}@test.local`,
        password: 'x',
        nickname: `选手${i}`,
      })),
    })
    const bulk = await prisma.user.findMany({
      where: { email: { startsWith: 'lb-bulk-' } },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    // 前 104 名是批量用户，第 105 名是自己。
    await seedSnapshot('total', [
      ...bulk.map((user, index) => ({ userId: user.id, points: 10_000 - index })),
      { userId: me.id, points: 7 },
    ])

    const res = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    expect(res.body.top).toHaveLength(100)
    expect(res.body.top.map((row: { rank: number }) => row.rank)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1)
    )
    expect(res.body.top.every((row: { isMe: boolean }) => row.isMe === false)).toBe(true)
    expect(res.body.me).toEqual({ rank: 105, points: 7, prevRank: null })
  })

  it('displayName 用昵称、缺失回退打码邮箱；isMe 由服务端标注 (验收 5)', async () => {
    const me = await makeUser('lb-api-me@test.local', { nickname: '  星河  ' })
    const other = await makeUser('lb-api-other@test.local')
    const token = (await loginAs('lb-api-me@test.local', PASSWORD)).accessToken
    await seedSnapshot('total', [
      { userId: other.id, points: 1280 },
      { userId: me.id, points: 80 },
    ])

    const res = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    expect(res.body.top).toEqual([
      { rank: 1, displayName: maskEmail('lb-api-other@test.local'), points: 1280, isMe: false, prevRank: null },
      { rank: 2, displayName: '星河', points: 80, isMe: true, prevRank: null },
    ])
    expect(res.body.me).toEqual({ rank: 2, points: 80, prevRank: null })
  })

  it('响应不含任何他人 userId / email，字段集恰为白名单 (P.6, LB-07, 验收 5)', async () => {
    const me = await makeUser('lb-api-canary-me@test.local', { nickname: '我' })
    const other = await makeUser('lb-api-canary-other@test.local')
    const token = (await loginAs('lb-api-canary-me@test.local', PASSWORD)).accessToken
    await seedSnapshot('total', [
      { userId: other.id, points: 500 },
      { userId: me.id, points: 100 },
    ])

    const res = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    const raw = JSON.stringify(res.body)

    // 金丝雀：邮箱原文与 userId 字段名都不得出现在任何层级。
    expect(raw).not.toContain('lb-api-canary-other@test.local')
    expect(raw).not.toContain('lb-api-canary-me@test.local')
    const keys = collectKeys(res.body)
    expect(keys.has('userId')).toBe(false)
    expect(keys.has('email')).toBe(false)
    expect(keys.has('balance')).toBe(false)
    expect(new Set(Object.keys(res.body.top[0]))).toEqual(new Set(['rank', 'displayName', 'points', 'isMe', 'prevRank']))
    // strict schema：多下发一个字段即失败。
    expect(LeaderboardResponseSchema.parse(res.body).top).toHaveLength(2)
  })

  it('admin 请求者 me 为 null（不入榜即无名次，验收 4）', async () => {
    await createTestUser('lb-api-admin-me@test.local', 'admin123', 'admin')
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: 'lb-api-admin-me@test.local' } })
    const player = await makeUser('lb-api-admin-player@test.local')
    const token = (await loginAs('lb-api-admin-me@test.local', 'admin123')).accessToken
    await seedSnapshot('total', [{ userId: player.id, points: 300 }])

    const res = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    expect(res.body.me).toBeNull()
    expect(res.body.top).toHaveLength(1)
    expect(await pointsOf('total', 'ALL', adminUser.id)).toBeNull()
  })

  it('updatedAt / dataThrough 由快照 computedAt 反推，cron 落后时不谎报新鲜度', async () => {
    const player = await makeUser('lb-api-fresh@test.local')
    const token = (await loginAs('lb-api-fresh@test.local', PASSWORD)).accessToken
    // 快照是"昨天算的"：dataThrough 必须停在前天，而不是随今天往前推一天。
    const computedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await seedSnapshot('total', [{ userId: player.id, points: 42 }], computedAt)

    const res = await api.get('/api/leaderboard').set(authHeader(token)).expect(200)
    expect(res.body.updatedAt).toBe(computedAt.toISOString())
    expect(res.body.dataThrough).toBe(addCalendarDays(businessDateString(computedAt), -1))
  })
})
