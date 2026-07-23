import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { applyTierBonus } from '../../lib/memberTier.js'

function getShanghaiDateString() {
  const now = new Date()
  const yyyy = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const mm = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit' })
  const dd = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', day: '2-digit' })
  return `${yyyy}-${mm}-${dd}`
}

export async function checkin(userId: number) {
  const dateStr = getShanghaiDateString()

  try {
    return await prisma.$transaction(async tx => {
      // The unique record is the single, database-backed claim for a daily
      // check-in. Claim it before changing the balance, so a concurrent
      // request rolls back cleanly instead of leaking Prisma P2002 as HTTP 500.
      await tx.checkinRecord.create({ data: { userId, date: dateStr } })

      const baseReward = await getSystemConfigValue('checkinReward', tx)
      const account = await tx.pointAccount.findUnique({ where: { userId } })
      if (!account) throw notFound('积分账户不存在')

      const lifetimeResult = await tx.pointLog.aggregate({
        where: { userId, type: 'in' },
        _sum: { amount: true },
      })
      const lifetimeBefore = lifetimeResult._sum.amount ?? 0
      const tierConfig = await getCurrentTierConfig()
      const tier = resolveTier(lifetimeBefore, tierConfig.thresholds)
      const { base, bonus, total } = applyTierBonus(baseReward, tier, tierConfig.bonusBps)

      const updatedAccount = await tx.pointAccount.update({
        where: { userId },
        data: { balance: { increment: total } },
      })

      await tx.pointLog.create({
        data: {
          userId,
          type: 'in',
          amount: total,
          balanceAfter: updatedAccount.balance,
          reason: bonus > 0 ? `每日打卡签到 (tier:${tier} +${bonus})` : '每日打卡签到',
        },
      })

      return {
        baseReward: base,
        bonusReward: bonus,
        totalReward: total,
        tier,
        balanceAfter: updatedAccount.balance,
      }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw badRequest('今日已签到')
    }
    throw error
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
