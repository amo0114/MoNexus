import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'

const defaultConfig = {
  registerReward: 500,
  checkinReward: 50,
  inviteReward: 200,
  refreshTokenMaxAgeDays: 7,
  defaultPageSize: 20,
  maxPageSize: 100,
  lowStockThreshold: 5,
  memberTierSilverThreshold: 1000,
  memberTierGoldThreshold: 5000,
  memberTierPlatinumThreshold: 20000,
  memberTierSilverBonusBps: 500,
  memberTierGoldBonusBps: 1000,
  memberTierPlatinumBonusBps: 2000,
} as const

async function clearSystemConfig() {
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF to_regclass('"SystemConfig"') IS NOT NULL THEN
        DELETE FROM "SystemConfig";
      END IF;
    END $$;
  `)
}

async function loginAdmin(email = 'config-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

function updateConfig(accessToken: string, key: string, value: number) {
  return api
    .put(`/api/admin/config/${key}`)
    .set(authHeader(accessToken))
    .send({ value })
}

describe('Admin system config', () => {
  beforeEach(async () => {
    await clearSystemConfig()
  })

  afterEach(async () => {
    await clearSystemConfig()
  })

  it('should list all known keys with defaults when database rows are missing', async () => {
    const { accessToken } = await loginAdmin()

    const res = await api
      .get('/api/admin/config')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toHaveLength(13)
    expect(res.body.map((item: any) => item.key)).toEqual(Object.keys(defaultConfig))

    for (const [key, defaultValue] of Object.entries(defaultConfig)) {
      expect(res.body).toContainEqual({
        key,
        value: defaultValue,
        defaultValue,
        updatedAt: null,
        updatedBy: null,
      })
    }
  })

  it('should allow an admin to update checkinReward', async () => {
    const { user: admin, accessToken } = await loginAdmin()

    const res = await updateConfig(accessToken, 'checkinReward', 77).expect(200)

    expect(res.body).toMatchObject({
      key: 'checkinReward',
      value: 77,
      defaultValue: defaultConfig.checkinReward,
      updatedBy: admin.id,
    })
    expect(typeof res.body.updatedAt).toBe('string')
  })

  it('should reject non-admin config updates', async () => {
    await createTestUser('config-user@test.local', 'pass123', 'user')
    const user = await loginAs('config-user@test.local', 'pass123')

    await updateConfig(user.accessToken, 'checkinReward', 77).expect(403)
  })

  it('should reject unknown config keys', async () => {
    const { accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'unknownReward', 10).expect(400)
  })

  it('should reject negative and non-integer values', async () => {
    const { accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'checkinReward', -1).expect(400)

    await api
      .put('/api/admin/config/checkinReward')
      .set(authHeader(accessToken))
      .send({ value: 1.5 })
      .expect(400)
  })

  it('should use updated checkinReward for future check-ins', async () => {
    const { accessToken: adminToken } = await loginAdmin()
    const { user, password } = await createTestUser('checkin-config@test.local', 'pass123', 'user', 0)
    const userLogin = await loginAs(user.email, password)

    await updateConfig(adminToken, 'checkinReward', 77).expect(200)

    const res = await api
      .post('/api/points/checkin')
      .set(authHeader(userLogin.accessToken))
      .expect(200)

    expect(res.body.baseReward).toBe(77)
    expect(res.body.bonusReward).toBe(0)
    expect(res.body.totalReward).toBe(77)
    expect(res.body.tier).toBe('bronze')
    expect(res.body.balanceAfter).toBe(77)

    const pointLog = await prisma.pointLog.findFirstOrThrow({
      where: { userId: user.id, reason: { startsWith: '每日打卡签到' } },
      orderBy: { id: 'desc' },
    })
    expect(pointLog.amount).toBe(77)
    expect(pointLog.balanceAfter).toBe(77)
    expect(pointLog.reason?.startsWith('每日打卡签到')).toBe(true)
  })

  it('should use updated registerReward for future registrations', async () => {
    const { accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'registerReward', 777).expect(200)

    const res = await api
      .post('/api/auth/register')
      .send({ email: 'register-config@test.local', password: 'pass123' })
      .expect(201)

    expect(res.body.user.points).toBe(777)

    const account = await prisma.pointAccount.findUniqueOrThrow({
      where: { userId: res.body.user.id },
    })
    expect(account.balance).toBe(777)
  })

  it('should use updated inviteReward for future invited registrations', async () => {
    const { accessToken } = await loginAdmin()
    const { user: inviter } = await createTestUser('inviter-config@test.local', 'pass123', 'user', 0)

    await updateConfig(accessToken, 'inviteReward', 333).expect(200)

    await api
      .post('/api/auth/register')
      .send({
        email: 'invitee-config@test.local',
        password: 'pass123',
        inviteCode: inviter.inviteCode,
      })
      .expect(201)

    const inviterAccount = await prisma.pointAccount.findUniqueOrThrow({
      where: { userId: inviter.id },
    })
    expect(inviterAccount.balance).toBe(333)
  })

  it('should write AdminLog when config is updated', async () => {
    const { user: admin, accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'checkinReward', 88).expect(200)

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'systemConfig' },
    })
    expect(log.action).toContain('配置')
    expect(log.detail).toContain('checkinReward')
    expect(log.detail).toContain('88')
  })

  it('should allow an admin to update business registry config keys', async () => {
    const { user: admin, accessToken } = await loginAdmin()

    const res = await updateConfig(accessToken, 'lowStockThreshold', 3).expect(200)

    expect(res.body).toMatchObject({
      key: 'lowStockThreshold',
      value: 3,
      defaultValue: defaultConfig.lowStockThreshold,
      updatedBy: admin.id,
    })

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'systemConfig' },
      orderBy: { id: 'desc' },
    })
    expect(log.detail).toContain('lowStockThreshold')
    expect(log.detail).toContain('3')
  })
})

describe('M7 member tier config', () => {
  beforeEach(async () => {
    await clearSystemConfig()
  })

  afterEach(async () => {
    await clearSystemConfig()
  })

  it('should list 6 tier keys via GET /api/admin/config with defaults', async () => {
    const { accessToken } = await loginAdmin()

    const res = await api
      .get('/api/admin/config')
      .set(authHeader(accessToken))
      .expect(200)

    const byKey = new Map<string, any>(res.body.map((item: any) => [item.key, item]))

    const tierDefaults: Record<string, number> = {
      memberTierSilverThreshold: 1000,
      memberTierGoldThreshold: 5000,
      memberTierPlatinumThreshold: 20000,
      memberTierSilverBonusBps: 500,
      memberTierGoldBonusBps: 1000,
      memberTierPlatinumBonusBps: 2000,
    }

    for (const [key, defaultValue] of Object.entries(tierDefaults)) {
      expect(byKey.get(key)).toMatchObject({
        key,
        value: defaultValue,
        defaultValue,
        updatedAt: null,
        updatedBy: null,
      })
    }
  })

  it('should reject memberTierGoldThreshold below silver threshold', async () => {
    const { accessToken } = await loginAdmin()

    const before = await prisma.adminLog.count({ where: { targetType: 'systemConfig' } })

    const res = await updateConfig(accessToken, 'memberTierGoldThreshold', 500).expect(400)
    expect(res.body.error.message).toContain('银卡 < 金卡 < 铂金')

    const after = await prisma.adminLog.count({ where: { targetType: 'systemConfig' } })
    expect(after).toBe(before)
    expect(
      await prisma.systemConfig.findUnique({ where: { key: 'memberTierGoldThreshold' } })
    ).toBeNull()
  })

  it('should reject memberTierPlatinumThreshold below gold threshold', async () => {
    const { accessToken } = await loginAdmin()

    const res = await updateConfig(accessToken, 'memberTierPlatinumThreshold', 4000).expect(400)
    expect(res.body.error.message).toContain('银卡 < 金卡 < 铂金')

    expect(
      await prisma.systemConfig.findUnique({ where: { key: 'memberTierPlatinumThreshold' } })
    ).toBeNull()
  })

  it('should reject memberTierSilverBonusBps above 10000', async () => {
    const { accessToken } = await loginAdmin()

    const res = await updateConfig(accessToken, 'memberTierSilverBonusBps', 10001).expect(400)
    expect(res.body.error.message).toContain('0..10000')

    expect(
      await prisma.systemConfig.findUnique({ where: { key: 'memberTierSilverBonusBps' } })
    ).toBeNull()
  })

  it('should reject memberTierGoldBonusBps below 0', async () => {
    const { accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'memberTierGoldBonusBps', -1).expect(400)

    expect(
      await prisma.systemConfig.findUnique({ where: { key: 'memberTierGoldBonusBps' } })
    ).toBeNull()
  })

  it('should accept a valid memberTierGoldThreshold change and write AdminLog', async () => {
    const { user: admin, accessToken } = await loginAdmin()

    const res = await updateConfig(accessToken, 'memberTierGoldThreshold', 8000).expect(200)
    expect(res.body).toMatchObject({
      key: 'memberTierGoldThreshold',
      value: 8000,
      defaultValue: 5000,
      updatedBy: admin.id,
    })

    const row = await prisma.systemConfig.findUniqueOrThrow({
      where: { key: 'memberTierGoldThreshold' },
    })
    expect(row.value).toBe(8000)

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'systemConfig' },
      orderBy: { id: 'desc' },
    })
    expect(log.detail).toContain('memberTierGoldThreshold')
    expect(log.detail).toContain('8000')
  })

  it('should re-validate the whole effective tier config when only one key changes', async () => {
    const { accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'memberTierSilverThreshold', 1000).expect(200)
    await updateConfig(accessToken, 'memberTierGoldThreshold', 5000).expect(200)
    await updateConfig(accessToken, 'memberTierPlatinumThreshold', 20000).expect(200)

    const res = await updateConfig(accessToken, 'memberTierSilverThreshold', 6000).expect(400)
    expect(res.body.error.message).toContain('银卡 < 金卡 < 铂金')

    const row = await prisma.systemConfig.findUniqueOrThrow({
      where: { key: 'memberTierSilverThreshold' },
    })
    expect(row.value).toBe(1000)
  })
})
