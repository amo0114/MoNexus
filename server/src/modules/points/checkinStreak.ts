import type { Prisma } from '@prisma/client'
import { addCalendarDays, businessMonthStart, diffCalendarDays } from '../../lib/businessTime.js'
import { getSystemConfigValue, type SystemConfigKey } from '../../lib/systemConfig.js'

/** SPEC-ENGAGE-001 CK-04：里程碑天数固定，金额走 SystemConfig。 */
export const STREAK_MILESTONES = [3, 7, 14, 30] as const
/** 30 天之后每满该天数再发一次 30 天档奖励。 */
export const STREAK_REPEAT_DAYS = 30
/** MK-01：只能补签今天之前 7 天内的日期。 */
export const MAKEUP_WINDOW_DAYS = 7

const MILESTONE_REWARD_KEYS: Record<typeof STREAK_MILESTONES[number], SystemConfigKey> = {
  3: 'checkinStreakReward3',
  7: 'checkinStreakReward7',
  14: 'checkinStreakReward14',
  30: 'checkinStreakReward30',
}

const DAY_MS = 24 * 60 * 60 * 1000

export type NewCheckinReward = {
  id: number
  kind: string
  milestone: number
  amount: number
  expiresAt: Date
}

/**
 * §3.4：签到 / 补签 / 领取按用户串行。每日签到另有唯一约束兜底，但连签
 * 计算要读前一日记录，不串行时「今日签到」与「补签昨日」并发会算错 streak。
 */
export async function lockUserCheckin(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkin:${userId}`}, 0))`
}

export function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 落在 (lo, hi] 区间内的里程碑：固定档 + 30 天之后的 60、90…… */
export function milestonesBetween(lo: number, hi: number): number[] {
  const result: number[] = STREAK_MILESTONES.filter(m => m > lo && m <= hi)
  for (let m = STREAK_REPEAT_DAYS * 2; m <= hi; m += STREAK_REPEAT_DAYS) {
    if (m > lo) result.push(m)
  }
  return result
}

export async function getMilestoneRewards(tx?: Prisma.TransactionClient) {
  const entries = await Promise.all(
    STREAK_MILESTONES.map(async m => [m, await getSystemConfigValue(MILESTONE_REWARD_KEYS[m], tx)] as const),
  )
  return new Map<number, number>(entries)
}

/** 30 天以后的循环档按 30 天档金额发放。 */
export function milestoneAmount(rewards: Map<number, number>, milestone: number): number {
  return rewards.get(milestone) ?? rewards.get(STREAK_REPEAT_DAYS) ?? 0
}

export async function previousStreak(tx: Prisma.TransactionClient, userId: number, date: string) {
  const prev = await tx.checkinRecord.findUnique({
    where: { userId_date: { userId, date: addCalendarDays(date, -1) } },
    select: { streak: true },
  })
  return prev?.streak ?? 0
}

/**
 * MK-05：在 date 补入一条记录后，按顺序重算其后直到下一个缺口的记录。
 * 返回该段连签的结束日、补签前结束日的 streak、重算后的 streak。
 */
export async function recomputeForward(
  tx: Prisma.TransactionClient,
  userId: number,
  date: string,
  streakAtDate: number,
  today: string,
) {
  const later = await tx.checkinRecord.findMany({
    where: { userId, date: { gt: date, lte: today } },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, streak: true },
  })
  let endDate = date
  let oldEnd = 0
  let streak = streakAtDate
  for (const row of later) {
    if (diffCalendarDays(row.date, endDate) !== 1) break
    oldEnd = row.streak
    streak += 1
    endDate = row.date
    await tx.checkinRecord.update({ where: { id: row.id }, data: { streak } })
  }
  return { endDate, oldEnd, newEnd: streak }
}

/**
 * CK-04 / CK-05：只为本次操作「新跨过」的里程碑生成奖励，避免迁移回填的
 * 长连签在上线首日被一次性补发。去重键 (userId, kind, periodKey, milestone)
 * 兜住重复评估与并发。
 */
export async function grantCheckinRewards(
  tx: Prisma.TransactionClient,
  userId: number,
  input: { runEndDate: string; crossedFrom: number; runEndStreak: number; touchedDate: string },
): Promise<NewCheckinReward[]> {
  const claimDays = await getSystemConfigValue('checkinRewardClaimDays', tx)
  const expiresAt = new Date(Date.now() + claimDays * DAY_MS)
  const rows: Prisma.CheckinRewardCreateManyInput[] = []

  const crossed = milestonesBetween(input.crossedFrom, input.runEndStreak)
  if (crossed.length > 0) {
    const rewards = await getMilestoneRewards(tx)
    const periodKey = addCalendarDays(input.runEndDate, -(input.runEndStreak - 1))
    for (const milestone of crossed) {
      const amount = milestoneAmount(rewards, milestone)
      if (amount > 0) rows.push({ userId, kind: 'streak', milestone, periodKey, amount, expiresAt })
    }
  }

  const monthKey = businessMonthStart(input.touchedDate).slice(0, 7)
  const monthDays = daysInMonth(monthKey)
  const checkedInMonth = await tx.checkinRecord.count({
    where: { userId, date: { gte: `${monthKey}-01`, lte: `${monthKey}-${String(monthDays).padStart(2, '0')}` } },
  })
  if (checkedInMonth === monthDays) {
    const amount = await getSystemConfigValue('checkinMonthlyReward', tx)
    if (amount > 0) rows.push({ userId, kind: 'monthly', milestone: monthDays, periodKey: monthKey, amount, expiresAt })
  }

  if (rows.length === 0) return []
  return tx.checkinReward.createManyAndReturn({
    data: rows,
    skipDuplicates: true,
    select: { id: true, kind: true, milestone: true, amount: true, expiresAt: true },
  })
}
