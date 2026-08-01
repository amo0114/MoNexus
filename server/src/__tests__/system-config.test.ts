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
  checkoutVerifyAmountThreshold: 0,
  checkoutVerifyDailyThreshold: 0,
  // P5 受控文件交付
  fileUrlTtlSeconds: 300,
  fileAccessWindowDays: 30,
  deliveryFileMaxMb: 100,
  // P5.5 低库存告警
  lowStockNotifyCooldownHours: 24,
  // P6a 订单计时
  autoCloseDays: 7,
  fulfillmentSlaDays: 7,
  subscriptionRemindDays: 3,
  // P7b 自动开通外呼尝试上限（0 = 暂停外呼）
  autoProvisionMaxAttempts: 5,
  // SPEC-OPS-REGMAIL-001 公开注册总开关（1 = 开启）
  registrationEnabled: 1,
  // SPEC-RAP-001 邮箱资格、奖励冷静期与邀请码额度
  emailVerificationRequiredForValue: 0,
  growthRewardHoldDays: 7,
  referralInviterMinAgeDays: 30,
  referralDailyQualifiedLimit: 3,
  referralLifetimeQualifiedLimit: 20,
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

    expect(res.body).toHaveLength(Object.keys(defaultConfig).length)
    expect(res.body.map((item: any) => item.key)).toEqual(Object.keys(defaultConfig))

    const byKey = new Map<string, any>(res.body.map((item: any) => [item.key, item]))
    for (const [key, defaultValue] of Object.entries(defaultConfig)) {
      expect(byKey.get(key)).toMatchObject({
        key,
        value: defaultValue,
        defaultValue,
        updatedAt: null,
        updatedBy: null,
      })
      expect(typeof byKey.get(key).description).toBe('string')
      expect(typeof byKey.get(key).group).toBe('string')
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

  it('should snapshot an updated registerReward for future registrations without immediate credit', async () => {
    const { accessToken } = await loginAdmin()

    await updateConfig(accessToken, 'registerReward', 777).expect(200)

    const res = await api
      .post('/api/auth/register')
      .send({ email: 'register-config@test.local', password: 'pass123' })
      .expect(201)

    expect(res.body.user.points).toBe(0)

    const account = await prisma.pointAccount.findUniqueOrThrow({
      where: { userId: res.body.user.id },
    })
    expect(account.balance).toBe(0)
    await expect(prisma.growthReward.findFirstOrThrow({
      where: { recipientUserId: res.body.user.id, kind: 'registration' },
    })).resolves.toMatchObject({ amount: 777, state: 'pending_verification' })
  })

  it('should snapshot an updated inviteReward for future eligible invited registrations', async () => {
    const { accessToken } = await loginAdmin()
    const { user: inviter } = await createTestUser('inviter-config@test.local', 'pass123', 'user', 0)
    await prisma.user.update({
      where: { id: inviter.id },
      data: {
        emailVerified: new Date(),
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000),
      },
    })

    await updateConfig(accessToken, 'inviteReward', 333).expect(200)

    await api
      .post('/api/auth/register')
      .send({
        email: 'invitee-config@test.local',
        password: 'pass123',
        inviteCode: inviter.inviteCode,
      })
      .expect(201)

    const inviterAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: inviter.id } })
    expect(inviterAccount.balance).toBe(0)
    await expect(prisma.growthReward.findFirstOrThrow({
      where: { recipientUserId: inviter.id, kind: 'referral' },
    })).resolves.toMatchObject({ amount: 333, state: 'pending_verification' })
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

// P5 复审回归：上限与 Nginx 的 100MB 锁定一致——101 必须 400。
describe('deliveryFileMaxMb is capped at the nginx limit', () => {
  it('rejects 101 and accepts 100', async () => {
    const { api, createTestUser, loginAs, authHeader } = await import('./helpers.js')
    await createTestUser('cfg-filemax@test.local', 'admin111', 'admin')
    const { accessToken } = await loginAs('cfg-filemax@test.local', 'admin111')

    const rejected = await api
      .put('/api/admin/config/deliveryFileMaxMb')
      .set(authHeader(accessToken))
      .send({ value: 101 })
      .expect(400)
    expect(rejected.body.error.message).toContain('100')

    await api
      .put('/api/admin/config/deliveryFileMaxMb')
      .set(authHeader(accessToken))
      .send({ value: 100 })
      .expect(200)
  })
})

describe('SPEC-RAP-001 system config registry and validation', () => {
  beforeEach(async () => {
    await clearSystemConfig()
  })

  afterEach(async () => {
    await clearSystemConfig()
  })

  it('lists the five registration abuse controls with defaults and admin metadata', async () => {
    const { accessToken } = await loginAdmin('rap-config-metadata@test.local')

    const res = await api
      .get('/api/admin/config')
      .set(authHeader(accessToken))
      .expect(200)

    const byKey = new Map<string, any>(res.body.map((item: any) => [item.key, item]))
    const expected = {
      emailVerificationRequiredForValue: {
        value: 0,
        group: '账户与注册',
        unit: '开关（0/1）',
      },
      growthRewardHoldDays: {
        value: 7,
        group: '奖励发放',
        unit: '天',
      },
      referralInviterMinAgeDays: {
        value: 30,
        group: '账户与注册',
        unit: '天',
      },
      referralDailyQualifiedLimit: {
        value: 3,
        group: '账户与注册',
        unit: '人/日',
      },
      referralLifetimeQualifiedLimit: {
        value: 20,
        group: '账户与注册',
        unit: '人',
      },
    } as const

    for (const [key, metadata] of Object.entries(expected)) {
      expect(byKey.get(key)).toMatchObject({
        key,
        value: metadata.value,
        defaultValue: metadata.value,
        group: metadata.group,
        unit: metadata.unit,
        updatedAt: null,
        updatedBy: null,
      })
      expect(byKey.get(key).description).toEqual(expect.any(String))
      expect(byKey.get(key).description.length).toBeGreaterThan(0)
      expect(byKey.get(key).hint).toEqual(expect.any(String))
      expect(byKey.get(key).hint.length).toBeGreaterThan(0)
    }
  })

  it('keeps both registration-related flags strictly boolean', async () => {
    const { accessToken } = await loginAdmin('rap-config-bool@test.local')

    for (const key of ['registrationEnabled', 'emailVerificationRequiredForValue']) {
      const res = await updateConfig(accessToken, key, 2).expect(400)
      expect(res.body.error.message).toContain('0（关闭）或 1（开启）')
      expect(await prisma.systemConfig.findUnique({ where: { key } })).toBeNull()
    }

    await updateConfig(accessToken, 'emailVerificationRequiredForValue', 1).expect(200)
    const row = await prisma.systemConfig.findUniqueOrThrow({
      where: { key: 'emailVerificationRequiredForValue' },
    })
    expect(row.value).toBe(1)
  })

  it('enforces each registration abuse control range, including legal boundaries', async () => {
    const { accessToken } = await loginAdmin('rap-config-ranges@test.local')

    const invalidValues: Array<[string, number, string]> = [
      ['growthRewardHoldDays', 31, '0..30'],
      ['referralInviterMinAgeDays', 366, '0..365'],
      ['referralDailyQualifiedLimit', 101, '0..100'],
      ['referralLifetimeQualifiedLimit', 10_001, '0..10000'],
    ]
    for (const [key, value, message] of invalidValues) {
      const res = await updateConfig(accessToken, key, value).expect(400)
      expect(res.body.error.message).toContain(message)
      expect(await prisma.systemConfig.findUnique({ where: { key } })).toBeNull()
    }

    await updateConfig(accessToken, 'growthRewardHoldDays', 0).expect(200)
    await updateConfig(accessToken, 'growthRewardHoldDays', 30).expect(200)
    await updateConfig(accessToken, 'referralInviterMinAgeDays', 0).expect(200)
    await updateConfig(accessToken, 'referralInviterMinAgeDays', 365).expect(200)
    await updateConfig(accessToken, 'referralLifetimeQualifiedLimit', 10_000).expect(200)
    await updateConfig(accessToken, 'referralDailyQualifiedLimit', 100).expect(200)
  })

  it('validates the effective daily/lifetime referral quota in the write transaction', async () => {
    const { accessToken } = await loginAdmin('rap-config-invariant@test.local')

    await updateConfig(accessToken, 'referralDailyQualifiedLimit', 10).expect(200)
    await updateConfig(accessToken, 'referralLifetimeQualifiedLimit', 10).expect(200)

    const logCountBeforeInvalidWrites = await prisma.adminLog.count({
      where: { targetType: 'systemConfig' },
    })
    for (const [key, value] of [
      ['referralDailyQualifiedLimit', 11],
      ['referralLifetimeQualifiedLimit', 9],
    ] as const) {
      const res = await updateConfig(accessToken, key, value).expect(400)
      expect(res.body.error.message).toContain('不得超过生命周期上限')
    }
    expect(
      await prisma.adminLog.count({ where: { targetType: 'systemConfig' } })
    ).toBe(logCountBeforeInvalidWrites)

    expect(
      (await prisma.systemConfig.findUniqueOrThrow({
        where: { key: 'referralDailyQualifiedLimit' },
      })).value
    ).toBe(10)
    expect(
      (await prisma.systemConfig.findUniqueOrThrow({
        where: { key: 'referralLifetimeQualifiedLimit' },
      })).value
    ).toBe(10)
  })

  it('allows a zero daily cap to pause referral qualification even when lifetime is zero', async () => {
    const { accessToken } = await loginAdmin('rap-config-zero-cap@test.local')

    await updateConfig(accessToken, 'referralDailyQualifiedLimit', 0).expect(200)
    await updateConfig(accessToken, 'referralLifetimeQualifiedLimit', 0).expect(200)

    const res = await updateConfig(accessToken, 'referralDailyQualifiedLimit', 1).expect(400)
    expect(res.body.error.message).toContain('不得超过生命周期上限')
  })
})
