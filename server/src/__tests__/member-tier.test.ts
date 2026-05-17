import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import {
  applyTierBonus,
  getCurrentTierConfig,
  resolveTier,
  type TierBonusBps,
} from '../lib/memberTier.js'

const tierConfigKeys = [
  'memberTierSilverThreshold',
  'memberTierGoldThreshold',
  'memberTierPlatinumThreshold',
  'memberTierSilverBonusBps',
  'memberTierGoldBonusBps',
  'memberTierPlatinumBonusBps',
] as const

async function clearTierConfig() {
  await prisma.systemConfig.deleteMany({
    where: { key: { in: [...tierConfigKeys] } },
  })
}

describe('member tier derivation', () => {
  beforeEach(async () => {
    await clearTierConfig()
  })

  afterEach(async () => {
    await clearTierConfig()
  })

  it('should require auth for GET /api/points/tier', async () => {
    const res = await api.get('/api/points/tier').expect(401)

    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('should return bronze tier for a fresh user with zero lifetime points', async () => {
    const config = await getCurrentTierConfig()
    const { user, password } = await createTestUser('tier-bronze@test.local', 'pass123', 'user', 0)
    const { accessToken } = await loginAs(user.email, password)

    const res = await api
      .get('/api/points/tier')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      tier: 'bronze',
      label: '普通会员',
      tone: 'neutral',
      lifetimeEarnedPoints: 0,
      bonusBps: 0,
      thresholds: config.thresholds,
      nextTier: 'silver',
      pointsToNextTier: config.thresholds.silver,
    })
  })

  it('should return silver tier and progress for lifetime points between silver and gold', async () => {
    const config = await getCurrentTierConfig()
    const lifetime = config.thresholds.silver
      + Math.floor((config.thresholds.gold - config.thresholds.silver) / 2)
    const { user, password } = await createTestUser('tier-silver@test.local', 'pass123', 'user', lifetime)
    const { accessToken } = await loginAs(user.email, password)

    const res = await api
      .get('/api/points/tier')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      tier: 'silver',
      label: '银卡',
      tone: 'info',
      lifetimeEarnedPoints: lifetime,
      bonusBps: config.bonusBps.silver,
      thresholds: config.thresholds,
      nextTier: 'gold',
      pointsToNextTier: config.thresholds.gold - lifetime,
    })
  })

  it('should return platinum tier without next progress above the platinum threshold', async () => {
    const config = await getCurrentTierConfig()
    const lifetime = config.thresholds.platinum + 1
    const { user, password } = await createTestUser('tier-platinum@test.local', 'pass123', 'user', lifetime)
    const { accessToken } = await loginAs(user.email, password)

    const res = await api
      .get('/api/points/tier')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      tier: 'platinum',
      label: '铂金',
      tone: 'success',
      lifetimeEarnedPoints: lifetime,
      bonusBps: config.bonusBps.platinum,
      thresholds: config.thresholds,
      nextTier: null,
      pointsToNextTier: 0,
    })
  })

  it('should apply tier bonus using floor bps math', () => {
    const bonusBps: TierBonusBps = {
      bronze: 0,
      silver: 500,
      gold: 1000,
      platinum: 2000,
    }

    expect(applyTierBonus(50, 'silver', bonusBps)).toEqual({
      base: 50,
      bonus: 2,
      total: 52,
    })
  })

  it('should resolve tier monotonically around thresholds', () => {
    const thresholds = { silver: 100, gold: 500, platinum: 1000 }

    expect(resolveTier(99, thresholds)).toBe('bronze')
    expect(resolveTier(100, thresholds)).toBe('silver')
    expect(resolveTier(499, thresholds)).toBe('silver')
    expect(resolveTier(500, thresholds)).toBe('gold')
    expect(resolveTier(999, thresholds)).toBe('gold')
    expect(resolveTier(1000, thresholds)).toBe('platinum')
  })

  it('should not create point, account, or admin log rows when reading tier', async () => {
    const { user, password } = await createTestUser('tier-readonly@test.local', 'pass123', 'user', 0)
    const { accessToken } = await loginAs(user.email, password)

    const before = {
      pointLogs: await prisma.pointLog.count(),
      pointAccounts: await prisma.pointAccount.count(),
      adminLogs: await prisma.adminLog.count(),
    }

    await api
      .get('/api/points/tier')
      .set(authHeader(accessToken))
      .expect(200)

    const after = {
      pointLogs: await prisma.pointLog.count(),
      pointAccounts: await prisma.pointAccount.count(),
      adminLogs: await prisma.adminLog.count(),
    }

    expect(after).toEqual(before)
  })
})
