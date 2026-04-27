import { prisma } from '../auth/service.js'
import { config } from '../../config/index.js'

export async function checkin(userId: number) {
  // 格式化为 YYYY-MM-DD（Asia/Shanghai 时区）
  const now = new Date()
  const yyyy = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const mm = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit' })
  const dd = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', day: '2-digit' })
  const dateStr = `${yyyy}-${mm}-${dd}`

  return prisma.$transaction(async (tx) => {
    // 检查是否已签到（唯一约束兜底）
    const existing = await tx.checkinRecord.findUnique({
      where: { userId_date: { userId, date: dateStr } },
    })
    if (existing) throw new Error('今日已签到')

    // 获取积分账户
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw new Error('积分账户不存在')

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
  const now = new Date()
  const yyyy = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const mm = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit' })
  const dd = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', day: '2-digit' })
  const dateStr = `${yyyy}-${mm}-${dd}`

  const record = await prisma.checkinRecord.findUnique({
    where: { userId_date: { userId, date: dateStr } },
  })
  return !!record
}
