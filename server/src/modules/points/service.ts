import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { badRequest, notFound } from '../../lib/httpError.js'

function getShanghaiDateString() {
  const now = new Date()
  const yyyy = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const mm = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit' })
  const dd = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', day: '2-digit' })
  return `${yyyy}-${mm}-${dd}`
}

export async function checkin(userId: number) {
  const dateStr = getShanghaiDateString()

  return prisma.$transaction(async tx => {
    const existing = await tx.checkinRecord.findUnique({
      where: { userId_date: { userId, date: dateStr } },
    })
    if (existing) throw badRequest('今日已签到')

    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw notFound('积分账户不存在')

    const newBalance = account.balance + config.checkinReward

    await tx.pointAccount.update({
      where: { userId },
      data: { balance: newBalance },
    })

    await tx.checkinRecord.create({
      data: { userId, date: dateStr },
    })

    await tx.pointLog.create({
      data: {
        userId,
        type: 'in',
        amount: config.checkinReward,
        balanceAfter: newBalance,
        reason: '每日打卡签到',
      },
    })

    return { reward: config.checkinReward, balanceAfter: newBalance }
  })
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
