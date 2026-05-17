import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { getCurrentTierConfig } from '../lib/memberTier.js'
import { getSystemConfigValue } from '../lib/systemConfig.js'

async function clearSystemConfig() {
  await prisma.systemConfig.deleteMany()
}

describe('M7 tier earning hooks', () => {
  beforeEach(async () => {
    await clearSystemConfig()
  })

  afterEach(async () => {
    await clearSystemConfig()
  })

  it('should keep bronze check-in at the base reward without bonus', async () => {
    const baseReward = await getSystemConfigValue('checkinReward')
    const { user, password } = await createTestUser('tier-checkin-bronze@test.local', 'pass123', 'user', 0)
    const { accessToken } = await loginAs(user.email, password)

    const res = await api
      .post('/api/points/checkin')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      baseReward,
      bonusReward: 0,
      totalReward: baseReward,
      tier: 'bronze',
      balanceAfter: baseReward,
    })

    const pointLog = await prisma.pointLog.findFirstOrThrow({
      where: { userId: user.id, reason: { startsWith: '每日打卡签到' } },
      orderBy: { id: 'desc' },
    })
    expect(pointLog.amount).toBe(baseReward)
    expect(pointLog.reason?.startsWith('每日打卡签到')).toBe(true)

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(baseReward)
  })

  it('should apply silver tier bonus to check-in reward', async () => {
    const config = await getCurrentTierConfig()
    const baseReward = await getSystemConfigValue('checkinReward')
    const { user, password } = await createTestUser(
      'tier-checkin-silver@test.local',
      'pass123',
      'user',
      config.thresholds.silver
    )
    const { accessToken } = await loginAs(user.email, password)
    const expectedBonus = Math.floor(baseReward * config.bonusBps.silver / 10000)
    const expectedTotal = baseReward + expectedBonus

    const res = await api
      .post('/api/points/checkin')
      .set(authHeader(accessToken))
      .expect(200)

    expect(expectedBonus).toBeGreaterThan(0)
    expect(res.body).toMatchObject({
      baseReward,
      bonusReward: expectedBonus,
      totalReward: expectedTotal,
      tier: 'silver',
      balanceAfter: config.thresholds.silver + expectedTotal,
    })

    const pointLog = await prisma.pointLog.findFirstOrThrow({
      where: { userId: user.id, reason: { startsWith: '每日打卡签到' } },
      orderBy: { id: 'desc' },
    })
    expect(pointLog.amount).toBe(expectedTotal)
    expect(pointLog.reason).toBe(`每日打卡签到 (tier:silver +${expectedBonus})`)
  })

  it('should apply platinum tier bonus to check-in reward', async () => {
    const config = await getCurrentTierConfig()
    const baseReward = await getSystemConfigValue('checkinReward')
    const { user, password } = await createTestUser(
      'tier-checkin-platinum@test.local',
      'pass123',
      'user',
      config.thresholds.platinum
    )
    const { accessToken } = await loginAs(user.email, password)
    const expectedBonus = Math.floor(baseReward * config.bonusBps.platinum / 10000)
    const expectedTotal = baseReward + expectedBonus

    const res = await api
      .post('/api/points/checkin')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      baseReward,
      bonusReward: expectedBonus,
      totalReward: expectedTotal,
      tier: 'platinum',
      balanceAfter: config.thresholds.platinum + expectedTotal,
    })

    const pointLog = await prisma.pointLog.findFirstOrThrow({
      where: { userId: user.id, reason: { startsWith: '每日打卡签到' } },
      orderBy: { id: 'desc' },
    })
    expect(pointLog.amount).toBe(expectedTotal)
    expect(pointLog.reason).toBe(`每日打卡签到 (tier:platinum +${expectedBonus})`)
  })

  it('should keep bronze inviter reward at the base invite reward', async () => {
    const inviteReward = await getSystemConfigValue('inviteReward')
    const { user: inviter } = await createTestUser('tier-invite-bronze@test.local', 'pass123', 'user', 0)
    const inviteeEmail = 'tier-invitee-bronze@test.local'

    await api
      .post('/api/auth/register')
      .send({ email: inviteeEmail, password: 'pass123', inviteCode: inviter.inviteCode })
      .expect(201)

    const pointLog = await prisma.pointLog.findFirstOrThrow({
      where: { userId: inviter.id },
      orderBy: { id: 'desc' },
    })
    expect(pointLog.amount).toBe(inviteReward)
    expect(pointLog.reason).toBe(`邀请新用户 ${inviteeEmail} 注册奖励`)
  })

  it('should apply gold tier bonus to inviter reward without changing invitee register reward', async () => {
    const config = await getCurrentTierConfig()
    const inviteReward = await getSystemConfigValue('inviteReward')
    const registerReward = await getSystemConfigValue('registerReward')
    const { user: inviter } = await createTestUser(
      'tier-invite-gold@test.local',
      'pass123',
      'user',
      config.thresholds.gold
    )
    const beforeLogs = await prisma.pointLog.findMany({
      where: { userId: inviter.id },
      orderBy: { id: 'asc' },
      select: { id: true, amount: true },
    })
    const beforeSum = beforeLogs.reduce((sum, log) => sum + log.amount, 0)
    const inviteeEmail = 'tier-invitee-gold@test.local'
    const expectedBonus = Math.floor(inviteReward * config.bonusBps.gold / 10000)
    const expectedTotal = inviteReward + expectedBonus

    const res = await api
      .post('/api/auth/register')
      .send({ email: inviteeEmail, password: 'pass123', inviteCode: inviter.inviteCode })
      .expect(201)

    expect(res.body.user.points).toBe(registerReward)

    const inviteeAccount = await prisma.pointAccount.findUniqueOrThrow({
      where: { userId: res.body.user.id },
    })
    expect(inviteeAccount.balance).toBe(registerReward)

    const afterLogs = await prisma.pointLog.findMany({
      where: { userId: inviter.id },
      orderBy: { id: 'asc' },
      select: { id: true, amount: true, reason: true },
    })
    expect(afterLogs).toHaveLength(beforeLogs.length + 1)

    for (const beforeLog of beforeLogs) {
      const afterLog = afterLogs.find(log => log.id === beforeLog.id)
      expect(afterLog?.amount).toBe(beforeLog.amount)
    }

    const afterSum = afterLogs.reduce((sum, log) => sum + log.amount, 0)
    const newLog = afterLogs[afterLogs.length - 1]
    expect(expectedBonus).toBeGreaterThan(0)
    expect(afterSum).toBe(beforeSum + expectedTotal)
    expect(newLog.amount).toBe(expectedTotal)
    expect(newLog.reason).toBe(`邀请新用户 ${inviteeEmail} 注册奖励 (tier:gold +${expectedBonus})`)
  })
})
