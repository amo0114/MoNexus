import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { applyTierBonus, GROWTH_LOG_WHERE } from '../../lib/memberTier.js'
import { creditInTx, spendInTx } from '../wallet/index.js'
import { assertSpendingNotRestricted } from './spendingPolicy.js'
import { sendPushToUser } from '../../lib/webPush.js'
import {
  addCalendarDays,
  businessDateString as getShanghaiDateString,
  businessMonthRange,
  diffCalendarDays,
} from '../../lib/businessTime.js'
import {
  daysInMonth,
  getMilestoneRewards,
  grantCheckinRewards,
  lockUserCheckin,
  MAKEUP_WINDOW_DAYS,
  milestoneAmount,
  milestonesBetween,
  previousStreak,
  recomputeForward,
  STREAK_MILESTONES,
  STREAK_REPEAT_DAYS,
  type NewCheckinReward,
} from './checkinStreak.js'

/**
 * 签到来源，仅用于统计，不参与幂等判定。
 *
 * 用开放的 string 而非 'web' | 'qq' 联合类型：机器人可接入的平台是开放的
 * （qq / telegram / discord ...），每支持一个平台就改一次类型是没必要的耦合。
 * 真正的幂等保证来自 CheckinRecord 的 @@unique([userId, date])。
 */
export type CheckinSource = string

export async function checkin(userId: number, source: CheckinSource = 'web') {
  const dateStr = getShanghaiDateString()

  try {
    const result = await prisma.$transaction(async tx => {
      await lockUserCheckin(tx, userId)
      // The unique record is the single, database-backed claim for a daily
      // check-in. Claim it before changing the balance, so a concurrent
      // request rolls back cleanly instead of leaking Prisma P2002 as HTTP 500.
      //
      // SPEC-CHAT-BOT-001: the bot path shares this exact claim. `source` is
      // statistics-only and deliberately NOT part of the uniqueness key, so a
      // web check-in and a bot check-in on the same day still collide.
      const streak = (await previousStreak(tx, userId, dateStr)) + 1
      await tx.checkinRecord.create({ data: { userId, date: dateStr, source, streak } })

      const baseReward = await getSystemConfigValue('checkinReward', tx)
      const account = await tx.pointAccount.findUnique({ where: { userId } })
      if (!account) throw notFound('积分账户不存在')

      const lifetimeResult = await tx.pointLog.aggregate({
        where: { userId, ...GROWTH_LOG_WHERE },
        _sum: { amount: true },
      })
      const lifetimeBefore = lifetimeResult._sum.amount ?? 0
      const tierConfig = await getCurrentTierConfig()
      const tier = resolveTier(lifetimeBefore, tierConfig.thresholds)
      const { base, bonus, total } = applyTierBonus(baseReward, tier, tierConfig.bonusBps)

      const { balance: balanceAfter } = await creditInTx(tx, {
        operationKey: `checkin:${userId}:${dateStr}`,
        userId,
        source: { kind: 'checkin', id: `${userId}:${dateStr}` },
        reasonCode: 'checkin_daily',
        log: { reason: bonus > 0 ? `每日打卡签到 (tier:${tier} +${bonus})` : '每日打卡签到', growthEligible: true },
      }, { amount: total, origin: 'reward' })

      const newRewards = await grantCheckinRewards(tx, userId, {
        runEndDate: dateStr,
        crossedFrom: streak - 1,
        runEndStreak: streak,
        touchedDate: dateStr,
      })

      return {
        baseReward: base,
        bonusReward: bonus,
        totalReward: total,
        tier,
        balanceAfter,
        streak,
        newRewards: newRewards.map(formatReward),
      }
    })
    notifyRewardsClaimable(userId, result.newRewards)
    return result
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw badRequest('今日已签到')
    }
    throw error
  }
}

function formatReward(reward: NewCheckinReward) {
  return {
    id: reward.id,
    kind: reward.kind,
    milestone: reward.milestone,
    amount: reward.amount,
    expiresAt: reward.expiresAt.toISOString(),
  }
}

/** PW-07：奖励待领取提示走 Web Push（尽力而为，失败不影响签到）。 */
function notifyRewardsClaimable(userId: number, rewards: ReturnType<typeof formatReward>[]) {
  if (rewards.length === 0) return
  const total = rewards.reduce((sum, r) => sum + r.amount, 0)
  void sendPushToUser(userId, {
    title: '签到奖励待领取',
    body: `你有 ${total} 积分的签到奖励可以领取`,
    deeplink: '/profile#checkin',
    tag: 'checkin-reward',
  })
}

/**
 * MK-01..MK-05：补签。付积分、不发每日奖励，只恢复连签与全勤资格。
 * expectedPrice 与当前价不一致时 409 PRICE_CHANGED，绝不按新价格扣费。
 */
export async function makeupCheckin(userId: number, date: string, expectedPrice: number) {
  const today = getShanghaiDateString()
  const offset = diffCalendarDays(today, date)
  if (offset < 1 || offset > MAKEUP_WINDOW_DAYS) {
    throw badRequest(`只能补签最近 ${MAKEUP_WINDOW_DAYS} 天内的日期`)
  }

  const result = await prisma.$transaction(async tx => {
    await lockUserCheckin(tx, userId)
    const limit = await getSystemConfigValue('checkinMakeupMonthlyLimit', tx)
    if (limit === 0) throw badRequest('补签暂未开放')
    const used = await countMakeupsThisMonth(userId, tx)
    if (used >= limit) throw badRequest('本月补签次数已用完')
    const price = await getSystemConfigValue('checkinMakeupPrice', tx)
    if (price !== expectedPrice) throw new HttpError(409, 'PRICE_CHANGED', '补签价格已变化，请重新确认')
    const existing = await tx.checkinRecord.findUnique({ where: { userId_date: { userId, date } } })
    if (existing) throw badRequest('该日已签到')

    await assertSpendingNotRestricted(userId, tx)
    const { balance: balanceAfter } = (await spendInTx(tx, {
      operationKey: `checkin-makeup:${userId}:${date}`,
      userId,
      source: { kind: 'checkin_makeup', id: `${userId}:${date}` },
      reasonCode: 'checkin_makeup',
      actorUserId: userId,
      log: { reason: `补签 ${date}` },
    }, { amount: price }))!

    const prefix = await previousStreak(tx, userId, date)
    await tx.checkinRecord.create({ data: { userId, date, source: 'makeup', streak: prefix + 1 } })
    const run = await recomputeForward(tx, userId, date, prefix + 1, today)
    const newRewards = await grantCheckinRewards(tx, userId, {
      runEndDate: run.endDate,
      crossedFrom: Math.max(prefix, run.oldEnd),
      runEndStreak: run.newEnd,
      touchedDate: date,
    })
    const current = await currentStreak(tx, userId, today)
    return { date, streak: current, balanceAfter, newRewards: newRewards.map(formatReward) }
  })
  notifyRewardsClaimable(userId, result.newRewards)
  return result
}

/** CK-06 / CK-07：领取待领取奖励。非本人 404；已领取幂等返回；过期 REWARD_EXPIRED。 */
export async function claimCheckinReward(userId: number, rewardId: number) {
  return prisma.$transaction(async tx => {
    await lockUserCheckin(tx, userId)
    const reward = await tx.checkinReward.findFirst({ where: { id: rewardId, userId } })
    if (!reward) throw notFound('奖励不存在')
    if (reward.state === 'claimed') {
      const account = await tx.pointAccount.findUnique({ where: { userId }, select: { balance: true } })
      return { id: reward.id, amount: reward.amount, balanceAfter: account?.balance ?? 0, alreadyClaimed: true }
    }
    if (reward.expiresAt.getTime() <= Date.now()) throw badRequest('奖励已过期', 'REWARD_EXPIRED')

    const { balance: balanceAfter, pointLogId } = await creditInTx(tx, {
      operationKey: `checkin-reward:${reward.id}`,
      userId,
      source: { kind: 'checkin_reward', id: reward.id },
      reasonCode: reward.kind === 'monthly' ? 'checkin_monthly' : 'checkin_streak',
      log: {
        reason: reward.kind === 'monthly'
          ? `${reward.periodKey} 月度全勤奖励`
          : `连签 ${reward.milestone} 天奖励`,
        growthEligible: true,
      },
    }, { amount: reward.amount, origin: 'reward' })
    await tx.checkinReward.update({
      where: { id: reward.id },
      data: { state: 'claimed', claimedAt: new Date(), pointLogId },
    })
    return { id: reward.id, amount: reward.amount, balanceAfter, alreadyClaimed: false }
  })
}

async function countMakeupsThisMonth(userId: number, db: Prisma.TransactionClient | typeof prisma = prisma) {
  return db.checkinRecord.count({ where: { userId, source: 'makeup', createdAt: businessMonthRange() } })
}

/** CK-03：今日已签取今日；今日未签而昨日已签取昨日（待续）；否则断签。 */
async function currentStreak(db: Prisma.TransactionClient | typeof prisma, userId: number, today: string) {
  const rows = await db.checkinRecord.findMany({
    where: { userId, date: { in: [today, addCalendarDays(today, -1)] } },
    select: { date: true, streak: true },
  })
  const todayRow = rows.find(r => r.date === today)
  if (todayRow) return todayRow.streak
  return rows[0]?.streak ?? 0
}

export async function getCheckinStatus(userId: number) {
  const today = getShanghaiDateString()
  const monthKey = today.slice(0, 7)
  const monthDays = daysInMonth(monthKey)

  const [recent, monthRows, milestoneRewards, monthlyReward, claimable, price, limit, used] = await Promise.all([
    prisma.checkinRecord.findMany({
      where: { userId, date: { gte: addCalendarDays(today, -MAKEUP_WINDOW_DAYS), lte: today } },
      select: { date: true, streak: true, source: true },
    }),
    prisma.checkinRecord.findMany({
      where: { userId, date: { gte: `${monthKey}-01`, lte: `${monthKey}-${String(monthDays).padStart(2, '0')}` } },
      orderBy: { date: 'asc' },
      select: { date: true, source: true },
    }),
    getMilestoneRewards(),
    getSystemConfigValue('checkinMonthlyReward'),
    prisma.checkinReward.findMany({
      where: { userId, state: 'claimable', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, milestone: true, amount: true, expiresAt: true },
    }),
    getSystemConfigValue('checkinMakeupPrice'),
    getSystemConfigValue('checkinMakeupMonthlyLimit'),
    countMakeupsThisMonth(userId),
  ])

  const byDate = new Map(recent.map(r => [r.date, r.streak]))
  const todayStreak = byDate.get(today)
  const yesterdayStreak = byDate.get(addCalendarDays(today, -1))
  const streak = todayStreak ?? yesterdayStreak ?? 0
  const streakState = todayStreak != null ? 'done' : yesterdayStreak != null ? 'pending' : 'broken'

  const upcoming = milestonesBetween(streak, streak + STREAK_REPEAT_DAYS)
    .map(days => ({ days, reward: milestoneAmount(milestoneRewards, days) }))
    .find(m => m.reward > 0) ?? null

  const makeupOpen = limit > 0 && used < limit
  const eligibleDates = makeupOpen
    ? Array.from({ length: MAKEUP_WINDOW_DAYS }, (_, i) => addCalendarDays(today, -(i + 1)))
      .filter(d => !byDate.has(d))
      .reverse()
    : []

  return {
    hasCheckedIn: todayStreak != null,
    today,
    streak,
    streakState,
    // 近几天的签到条会跨月，month.checked 只含当月，不够用。
    recent: recent.map(r => ({ date: r.date, makeup: r.source === 'makeup' })),
    month: {
      key: monthKey,
      daysInMonth: monthDays,
      checked: monthRows.map(r => ({ date: r.date, makeup: r.source === 'makeup' })),
    },
    milestones: STREAK_MILESTONES
      .map(days => ({ days, reward: milestoneRewards.get(days) ?? 0, reached: streak >= days }))
      .filter(m => m.reward > 0),
    repeatEveryDays: STREAK_REPEAT_DAYS,
    nextMilestone: upcoming,
    monthlyReward,
    claimable: claimable.map(formatReward),
    makeup: { price, monthlyLimit: limit, usedThisMonth: used, windowDays: MAKEUP_WINDOW_DAYS, eligibleDates },
  }
}

export async function getHistory(userId: number) {
  return prisma.pointLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
}

export async function hasCheckedInToday(userId: number) {
  const dateStr = getShanghaiDateString()

  const record = await prisma.checkinRecord.findUnique({
    where: { userId_date: { userId, date: dateStr } },
  })
  return !!record
}

import {
  computeLifetimeEarnedPoints,
  getCurrentTierConfig,
  resolveTier,
  formatTierResponse,
} from '../../lib/memberTier.js'

export async function getTier(userId: number) {
  const [lifetime, config] = await Promise.all([
    computeLifetimeEarnedPoints(userId),
    getCurrentTierConfig(),
  ])
  const tier = resolveTier(lifetime, config.thresholds)
  return formatTierResponse(userId, lifetime, tier, config)
}

/**
 * SPEC-CHAT-BOT-001: the bot needs balance + tier in one round trip so a
 * 「我的积分」 query is a single HTTP call, not three.
 */
export async function getAccountSummary(userId: number) {
  const [account, tierInfo] = await Promise.all([
    prisma.pointAccount.findUnique({ where: { userId } }),
    getTier(userId),
  ])
  return {
    balance: account?.balance ?? 0,
    frozenBalance: account?.frozenBalance ?? 0,
    tier: tierInfo,
  }
}
