import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { addCalendarDays, businessDateString } from '../lib/businessTime.js'
import { grantCheckinRewards } from '../modules/points/checkinStreak.js'
import { __resetActiveDayMemoForTests } from '../lib/activeDay.js'

const PASSWORD = 'Reg1ster#Flow-2026'

async function signedInUser(email: string, balance = 1000) {
  const { user } = await createTestUser(email, PASSWORD, 'user', balance)
  const { accessToken } = await loginAs(user.email, PASSWORD)
  return { user, headers: authHeader(accessToken) }
}

async function seedCheckins(userId: number, dates: Array<[string, number]>) {
  await prisma.checkinRecord.createMany({
    data: dates.map(([date, streak]) => ({ userId, date, streak, source: 'qq' })),
  })
}

const today = () => businessDateString()
const daysAgo = (n: number) => addCalendarDays(today(), -n)

describe('SPEC-ENGAGE-001 check-in streak', () => {
  it('continues a streak, grants the crossed milestone and claims it once', async () => {
    const { user, headers } = await signedInUser('streak-claim@test.local')
    await seedCheckins(user.id, [[daysAgo(2), 1], [daysAgo(1), 2]])

    const res = await api.post('/api/points/checkin').set(headers).expect(200)
    expect(res.body.streak).toBe(3)
    expect(res.body.newRewards).toEqual([
      expect.objectContaining({ kind: 'streak', milestone: 3, amount: 5 }),
    ])

    const status = await api.get('/api/points/checkin/status').set(headers).expect(200)
    expect(status.body).toMatchObject({ hasCheckedIn: true, streak: 3, streakState: 'done' })
    expect(status.body.nextMilestone).toEqual({ days: 7, reward: 10 })
    expect(status.body.recent.map((r: { date: string }) => r.date).sort()).toEqual([daysAgo(2), daysAgo(1), daysAgo(0)])
    const rewardId = status.body.claimable[0].id

    const before = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    const claim = await api.post(`/api/points/checkin/rewards/${rewardId}/claim`).set(headers).expect(200)
    expect(claim.body).toMatchObject({ amount: 5, balanceAfter: before.balance + 5, alreadyClaimed: false })

    const again = await api.post(`/api/points/checkin/rewards/${rewardId}/claim`).set(headers).expect(200)
    expect(again.body).toMatchObject({ alreadyClaimed: true, balanceAfter: before.balance + 5 })
    expect(await prisma.pointLog.count({ where: { userId: user.id, reason: '连签 3 天奖励' } })).toBe(1)

    const other = await signedInUser('streak-claim-other@test.local')
    await api.post(`/api/points/checkin/rewards/${rewardId}/claim`).set(other.headers).expect(404)
  })

  it('does not retro-grant milestones for a long backfilled streak', async () => {
    const { user, headers } = await signedInUser('streak-long@test.local')
    await seedCheckins(user.id, [[daysAgo(1), 40]])

    const res = await api.post('/api/points/checkin').set(headers).expect(200)
    expect(res.body.streak).toBe(41)
    expect(res.body.newRewards).toEqual([])
  })

  it('makeup bridges two runs without a daily reward and honors expectedPrice', async () => {
    const { user, headers } = await signedInUser('streak-makeup@test.local')
    await seedCheckins(user.id, [[daysAgo(5), 1], [daysAgo(4), 2], [daysAgo(2), 1], [daysAgo(1), 2]])

    await api.post('/api/points/checkin/makeup').set(headers)
      .send({ date: daysAgo(3), expectedPrice: 19 }).expect(409)
    await api.post('/api/points/checkin/makeup').set(headers)
      .send({ date: daysAgo(8), expectedPrice: 20 }).expect(400)
    await api.post('/api/points/checkin/makeup').set(headers)
      .send({ date: daysAgo(2), expectedPrice: 20 }).expect(400)
    await api.post('/api/points/checkin/makeup').set(headers)
      .send({ date: '2026-02-31', expectedPrice: 20 }).expect(400)

    const res = await api.post('/api/points/checkin/makeup').set(headers)
      .send({ date: daysAgo(3), expectedPrice: 20 }).expect(200)
    expect(res.body).toMatchObject({ streak: 5, balanceAfter: 980 })
    expect(res.body.newRewards).toEqual([
      expect.objectContaining({ kind: 'streak', milestone: 3, amount: 5 }),
    ])

    const rows = await prisma.checkinRecord.findMany({ where: { userId: user.id }, orderBy: { date: 'asc' } })
    expect(rows.map(r => r.streak)).toEqual([1, 2, 3, 4, 5])
    const reward = await prisma.checkinReward.findFirstOrThrow({ where: { userId: user.id } })
    expect(reward.periodKey).toBe(daysAgo(5))
  })

  it('enforces the monthly makeup limit', async () => {
    const { headers } = await signedInUser('streak-makeup-limit@test.local')
    await prisma.systemConfig.create({ data: { key: 'checkinMakeupMonthlyLimit', value: 1 } })
    try {
      await api.post('/api/points/checkin/makeup').set(headers).send({ date: daysAgo(1), expectedPrice: 20 }).expect(200)
      await api.post('/api/points/checkin/makeup').set(headers).send({ date: daysAgo(2), expectedPrice: 20 }).expect(400)
    } finally {
      await prisma.systemConfig.deleteMany({ where: { key: 'checkinMakeupMonthlyLimit' } })
    }
  })

  it('serializes a concurrent check-in and makeup of yesterday', async () => {
    const { user, headers } = await signedInUser('streak-race@test.local')
    await seedCheckins(user.id, [[daysAgo(2), 1]])

    await Promise.all([
      api.post('/api/points/checkin').set(headers).expect(200),
      api.post('/api/points/checkin/makeup').set(headers).send({ date: daysAgo(1), expectedPrice: 20 }).expect(200),
    ])

    const rows = await prisma.checkinRecord.findMany({ where: { userId: user.id }, orderBy: { date: 'asc' } })
    expect(rows.map(r => r.streak)).toEqual([1, 2, 3])
    expect(await prisma.checkinReward.count({ where: { userId: user.id, kind: 'streak', milestone: 3 } })).toBe(1)
  })

  it('grants the monthly reward when every day of the month is checked', async () => {
    const { user } = await signedInUser('streak-monthly@test.local')
    await seedCheckins(user.id, Array.from({ length: 28 }, (_, i) => [
      `2026-02-${String(i + 1).padStart(2, '0')}`, i + 1,
    ] as [string, number]))

    const rewards = await prisma.$transaction(tx => grantCheckinRewards(tx, user.id, {
      runEndDate: '2026-02-28', crossedFrom: 28, runEndStreak: 28, touchedDate: '2026-02-28',
    }))
    expect(rewards).toEqual([expect.objectContaining({ kind: 'monthly', milestone: 28, amount: 20 })])
  })

  it('rejects an expired reward', async () => {
    const { user, headers } = await signedInUser('streak-expired@test.local')
    const reward = await prisma.checkinReward.create({
      data: { userId: user.id, kind: 'streak', milestone: 7, periodKey: daysAgo(10), amount: 10, expiresAt: new Date(Date.now() - 1000) },
    })
    const res = await api.post(`/api/points/checkin/rewards/${reward.id}/claim`).set(headers).expect(400)
    expect(res.body.error.code).toBe('REWARD_EXPIRED')
  })

  it('records the authenticated user active day once', async () => {
    const { user, headers } = await signedInUser('active-day@test.local')
    // TRUNCATE ... RESTART IDENTITY 会复用 userId，清掉前面用例留下的进程内去重。
    __resetActiveDayMemoForTests()
    await api.get('/api/points/checkin/status').set(headers).expect(200)
    await api.get('/api/points/tier').set(headers).expect(200)
    await expect.poll(() => prisma.userActiveDay.count({ where: { userId: user.id } })).toBe(1)
    expect((await prisma.userActiveDay.findFirstOrThrow({ where: { userId: user.id } })).day).toBe(today())
  })
})
