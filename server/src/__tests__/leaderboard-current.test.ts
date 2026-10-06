import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { getLeaderboard } from '../modules/leaderboard/service.js'
import { resolveUserAvatarUrl } from '../modules/auth/avatarPresets.js'

const at = (day: string, time = '12:00:00') => new Date(`${day}T${time}+08:00`)
const NOW = at('2026-05-20', '06:00:00')

function user(nickname: string) {
  return prisma.user.create({ data: { email: `${nickname}@test.local`, password: 'x', nickname } })
}

function earn(userId: number, amount: number, createdAt: Date, type = 'in') {
  return prisma.pointLog.create({ data: { userId, amount, type, createdAt, balanceAfter: 0, reason: 'current board test' } })
}

describe('current leaderboard — calendar periods including today', () => {
  it('uses half-open natural periods in every database timezone and excludes future entries', async () => {
    const a = await user('boundaries')
    await earn(a.id, 1, at('2026-04-30', '23:59:59.999'))
    await earn(a.id, 2, at('2026-05-01', '00:00:00'))
    await earn(a.id, 4, at('2026-05-17', '23:59:59.999'))
    await earn(a.id, 8, at('2026-05-18', '00:00:00'))
    await earn(a.id, 16, at('2026-05-20', '00:00:00'))
    await earn(a.id, 32, new Date(NOW.getTime() - 1))
    await earn(a.id, 64, NOW)
    await earn(a.id, 128, new Date(NOW.getTime() + 1))
    for (const type of ['out', 'hold', 'release', 'refund']) await earn(a.id, 1024, at('2026-05-19'), type)
    await earn(a.id, 0, at('2026-05-19'))
    await earn(a.id, -2048, at('2026-05-19'))

    for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      await prisma.$transaction(async client => {
        await client.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
        for (const [scope, points, periodKey] of [
          ['total', 63, 'ALL'], ['month', 62, 'M2026-05'], ['week', 56, 'W2026-05-18'],
        ] as const) {
          const board = await getLeaderboard(scope, a.id, { now: NOW, client })
          expect(board.me).toEqual({ rank: 1, points, prevRank: 1 })
          expect(board.periodKey).toBe(periodKey)
          expect(board.dataThrough).toBe('2026-05-20')
          expect(board.updatedAt).toBe(NOW.toISOString())
        }
      })
    }
  })

  it('can enter week and month rankings on their first day without a refresh job', async () => {
    const a = await user('new-period')
    await earn(a.id, 500, at('2026-05-31', '23:59:59.999'))
    await earn(a.id, 5, at('2026-06-01', '00:00:00')) // Monday and month start
    for (const scope of ['week', 'month'] as const) {
      const board = await getLeaderboard(scope, a.id, { now: at('2026-06-01', '00:00:01') })
      expect(board.me).toEqual({ rank: 1, points: 5, prevRank: null })
    }
    expect(await prisma.leaderboardEntry.count()).toBe(0)
  })

  it('keeps a cross-year week together while starting a new calendar month', async () => {
    const a = await user('cross-year')
    await earn(a.id, 10, at('2026-12-31', '23:59:59'))
    await earn(a.id, 5, at('2027-01-01', '00:00:00'))
    const now = at('2027-01-01', '00:00:01')
    const week = await getLeaderboard('week', a.id, { now })
    expect(week.periodKey).toBe('W2026-12-28')
    expect(week.periodLabel).toBe('2026-12-28 ~ 2027-01-03')
    expect(week.me?.points).toBe(15)
    const month = await getLeaderboard('month', a.id, { now })
    expect(month.periodKey).toBe('M2027-01')
    expect(month.me).toEqual({ rank: 1, points: 5, prevRank: null })
  })

  it('compares ranks with midnight and does not consume changes on repeated reads', async () => {
    const a = await user('previous-leader')
    const b = await user('new-leader')
    const c = await user('new-entry')
    await earn(a.id, 100, at('2026-05-19'))
    await earn(b.id, 50, at('2026-05-19'))
    await earn(b.id, 100, at('2026-05-20', '01:00:00'))
    await earn(c.id, 10, at('2026-05-20', '02:00:00'))
    for (let i = 0; i < 2; i++) {
      const board = await getLeaderboard('week', b.id, { now: NOW })
      expect(board.top.map(row => [row.displayName, row.rank, row.prevRank])).toEqual([
        ['new-leader', 1, 2], ['previous-leader', 2, 1], ['new-entry', 3, null],
      ])
      expect(board.me).toEqual({ rank: 1, points: 150, prevRank: 2 })
    }
  })

  it('uses the same tie ordering in current and previous ranks', async () => {
    const a = await user('late')
    const b = await user('early-a')
    const c = await user('early-b')
    await earn(a.id, 50, at('2026-05-19', '15:00:00'))
    await earn(b.id, 50, at('2026-05-19', '12:00:00'))
    await earn(c.id, 50, at('2026-05-19', '12:00:00'))
    const board = await getLeaderboard('total', a.id, { now: NOW })
    expect(board.top.map(row => [row.displayName, row.rank, row.prevRank])).toEqual([
      ['early-a', 1, 1], ['early-b', 2, 2], ['late', 3, 3],
    ])
  })

  it('rechecks eligibility immediately and keeps merchant participation', async () => {
    const a = await user('banned-after-read')
    const b = await user('merchant')
    const admin = await user('admin')
    await prisma.user.update({ where: { id: b.id }, data: { role: 'merchant' } })
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'admin' } })
    for (const u of [a, b, admin]) await earn(u.id, 50, at('2026-05-19'))
    expect((await getLeaderboard('total', a.id, { now: NOW })).top).toHaveLength(2)
    await prisma.user.update({ where: { id: a.id }, data: { status: '已封禁' } })
    const board = await getLeaderboard('total', a.id, { now: NOW })
    expect(board.me).toBeNull()
    expect(board.top.map(row => row.displayName)).toEqual(['merchant'])
  })

  it('projects a stable preset through renames, prioritizes selections, and restores defaults on clear', async () => {
    const a = await user('avatar-original')
    await earn(a.id, 1, at('2026-05-19'))
    const original = (await getLeaderboard('total', a.id, { now: NOW })).top[0]
    expect(original.avatarUrl).toBe(resolveUserAvatarUrl(a))
    expect(original.avatarUrl).toMatch(/^\/assets\/avatars\/three-kingdoms\/v2\.3\//)
    await prisma.user.update({ where: { id: a.id }, data: { nickname: 'renamed' } })
    expect((await getLeaderboard('total', a.id, { now: NOW })).top[0].avatarUrl).toBe(original.avatarUrl)
    for (const avatarUrl of ['/assets/avatars/three-kingdoms/v2.3/shu-zhao-yun.webp', 'https://files.example/avatar.webp']) {
      await prisma.user.update({ where: { id: a.id }, data: { avatarUrl } })
      expect((await getLeaderboard('total', a.id, { now: NOW })).top[0].avatarUrl).toBe(avatarUrl)
    }
    await prisma.user.update({ where: { id: a.id }, data: { avatarUrl: null } })
    expect((await getLeaderboard('total', a.id, { now: NOW })).top[0].avatarUrl).toBe(original.avatarUrl)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).avatarUrl).toBeNull()
  })
})
