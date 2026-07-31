import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { __resetRedisForTests, __setRedisForTests, type RedisLike } from '../lib/redis.js'
import {
  __resetHumanVerifierForTesting,
  __setHumanVerifierForTesting,
} from '../modules/auth/humanVerification.js'
import { registerUser, verifyEmailWithToken } from '../modules/auth/service.js'
import {
  __runGrowthRewardCronTickForTests,
} from '../modules/auth/growthRewardCron.js'
import {
  releaseMatureGrowthRewards,
  voidGrowthReward,
} from '../modules/auth/growthRewards.js'
import { createTestUser } from './helpers.js'

const DAY_MS = 24 * 60 * 60 * 1_000

class PendingReferralLimitedRedis implements RedisLike {
  status = 'ready'

  async get() { return null }
  async set() { return 'OK' }
  async del() { return 0 }
  async incr() { return 1 }
  async ping() { return 'PONG' }

  async eval(_script: string, _numberOfKeys: number, key: string, rawTtl: string) {
    // Flow/dimension are fixed, non-sensitive parts of a limiter key. The
    // identifier suffix remains HMACed and is intentionally never inspected.
    return key.includes(':referral-pending:')
      ? [7, Number(rawTtl)]
      : [1, Number(rawTtl)]
  }
}

function hashToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

async function setConfig(key: string, value: number) {
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value, description: 'RAP growth reward test' },
    update: { value },
  })
}

async function makeEligibleInviter(email: string, balance = 0) {
  const { user } = await createTestUser(email, 'pass123', 'user', balance)
  const inviter = await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: new Date(),
      createdAt: new Date(Date.now() - 31 * DAY_MS),
    },
  })
  return inviter
}

async function createVerificationToken(userId: number, suffix: string) {
  const rawToken = `growth-reward-verification-${suffix}-${crypto.randomUUID()}`
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  })
  return rawToken
}

async function registerThenVerify(email: string, inviteCode?: string) {
  const registered = await registerUser(email, 'pass123', inviteCode)
  const token = await createVerificationToken(registered.user.id, email)
  await verifyEmailWithToken(registered.user.id, token)
  return registered.user
}

describe('SPEC-RAP-001 growth reward held ledger', () => {
  beforeEach(async () => {
    await prisma.systemConfig.deleteMany()
  })

  afterEach(async () => {
    await prisma.systemConfig.deleteMany()
  })

  it('creates only a zero-balance account and a single pending registration reward', async () => {
    await setConfig('registerReward', 777)

    const registered = await registerUser('held-registration@test.local', 'pass123')
    expect(registered.user.points).toBe(0)

    await expect(prisma.pointAccount.findUniqueOrThrow({ where: { userId: registered.user.id } }))
      .resolves.toMatchObject({ balance: 0 })
    expect(await prisma.pointLog.count({ where: { userId: registered.user.id } })).toBe(0)
    await expect(prisma.growthReward.findFirstOrThrow({
      where: { recipientUserId: registered.user.id, kind: 'registration' },
    })).resolves.toMatchObject({
      amount: 777,
      state: 'pending_verification',
      dedupeKey: `registration:${registered.user.id}`,
      availableAt: null,
    })

    const token = await createVerificationToken(registered.user.id, 'held-registration')
    await verifyEmailWithToken(registered.user.id, token)
    await expect(verifyEmailWithToken(registered.user.id, token)).rejects.toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    })
    expect(await prisma.growthReward.count({
      where: { recipientUserId: registered.user.id, kind: 'registration' },
    })).toBe(1)
  })

  it('only binds a currently eligible inviter and freezes its tier-adjusted referral amount', async () => {
    const ineligible = await createTestUser('ineligible-referrer@test.local', 'pass123', 'user', 0)
    const unbound = await registerUser('unbound-invitee@test.local', 'pass123', ineligible.user.inviteCode)
    expect(await prisma.inviteRelation.count({ where: { inviteeId: unbound.user.id } })).toBe(0)

    const eligible = await makeEligibleInviter('eligible-gold-referrer@test.local', 5_000)
    await setConfig('inviteReward', 333)
    const bound = await registerUser('bound-invitee@test.local', 'pass123', eligible.inviteCode)
    const relation = await prisma.inviteRelation.findUniqueOrThrow({ where: { inviteeId: bound.user.id } })
    const reward = await prisma.growthReward.findUniqueOrThrow({ where: { inviteRelationId: relation.id } })

    expect(relation).toMatchObject({ inviterId: eligible.id, status: 'pending_verification' })
    // Default gold bonus is 10%; this amount remains frozen even if the
    // current SystemConfig changes before the invitee verifies their email.
    expect(reward).toMatchObject({ kind: 'referral', amount: 366, state: 'pending_verification' })
    await setConfig('inviteReward', 1)
    expect((await prisma.growthReward.findUniqueOrThrow({ where: { id: reward.id } })).amount).toBe(366)
  })

  it('does not let a full pending-referral Redis bucket block the invitee base registration', async () => {
    const original = {
      mode: config.abuseProtectionMode,
      hashKey: config.abuseHashKey,
      redisEnabled: config.redisEnabled,
      redisRequired: config.redisRequired,
      cacheKeyPrefix: config.cacheKeyPrefix,
      siteKey: config.turnstile.siteKey,
      secretKey: config.turnstile.secretKey,
      allowedHostnames: [...config.turnstile.allowedHostnames],
    }
    try {
      config.abuseProtectionMode = 'enforce'
      config.abuseHashKey = Buffer.alloc(32, 0x75)
      config.redisEnabled = true
      config.redisRequired = true
      config.cacheKeyPrefix = 'rap-growth-test'
      config.turnstile.siteKey = 'public-test-site-key'
      config.turnstile.secretKey = 'private-test-secret'
      config.turnstile.allowedHostnames = ['localhost']
      __setRedisForTests(new PendingReferralLimitedRedis())
      __setHumanVerifierForTesting({ verifyRegistration: async () => ({ kind: 'verified' }) })

      const inviter = await makeEligibleInviter('pending-cap-referrer@test.local')
      const registered = await registerUser(
        'pending-cap-invitee@test.local',
        'pass123',
        inviter.inviteCode,
        '203.0.113.200',
        undefined,
        'managed-proof',
      )

      expect(registered.user.points).toBe(0)
      expect(await prisma.inviteRelation.count({ where: { inviteeId: registered.user.id } })).toBe(0)
      await expect(prisma.growthReward.findFirstOrThrow({
        where: { recipientUserId: registered.user.id, kind: 'registration' },
      })).resolves.toMatchObject({ state: 'pending_verification' })
    } finally {
      config.abuseProtectionMode = original.mode
      config.abuseHashKey = original.hashKey
      config.redisEnabled = original.redisEnabled
      config.redisRequired = original.redisRequired
      config.cacheKeyPrefix = original.cacheKeyPrefix
      config.turnstile.siteKey = original.siteKey
      config.turnstile.secretKey = original.secretKey
      config.turnstile.allowedHostnames = original.allowedHostnames
      __resetRedisForTests()
      __resetHumanVerifierForTesting()
    }
  })

  it('uses the inviter row lock so only one concurrent verification claims the final quota slot', async () => {
    await setConfig('referralDailyQualifiedLimit', 1)
    await setConfig('referralLifetimeQualifiedLimit', 1)
    const inviter = await makeEligibleInviter('quota-lock-referrer@test.local')

    const first = await registerUser('quota-lock-a@test.local', 'pass123', inviter.inviteCode)
    const second = await registerUser('quota-lock-b@test.local', 'pass123', inviter.inviteCode)
    const firstToken = await createVerificationToken(first.user.id, 'quota-a')
    const secondToken = await createVerificationToken(second.user.id, 'quota-b')

    // A Promise barrier starts both real PostgreSQL token-claim transactions
    // together. The result depends on row locking, not sleeps or a JS mutex.
    let releaseBarrier: (() => void) | undefined
    const barrier = new Promise<void>(resolve => { releaseBarrier = resolve })
    const attempts = [
      async () => { await barrier; return verifyEmailWithToken(first.user.id, firstToken) },
      async () => { await barrier; return verifyEmailWithToken(second.user.id, secondToken) },
    ].map(run => run())
    releaseBarrier!()
    await expect(Promise.all(attempts)).resolves.toHaveLength(2)

    const relations = await prisma.inviteRelation.findMany({
      where: { inviterId: inviter.id },
      orderBy: { inviteeId: 'asc' },
    })
    expect(relations.filter(relation => relation.status === 'qualified')).toHaveLength(1)
    expect(relations.filter(relation => relation.status === 'quota_exhausted')).toHaveLength(1)
    expect(await prisma.growthReward.count({
      where: { recipientUserId: inviter.id, kind: 'referral', state: 'held' },
    })).toBe(1)
    expect(await prisma.growthReward.count({
      where: { recipientUserId: inviter.id, kind: 'referral', state: 'voided' },
    })).toBe(1)
    expect(await prisma.growthReward.count({
      where: { kind: 'registration', recipientUserId: { in: [first.user.id, second.user.id] }, state: 'held' },
    })).toBe(2)
  })

  it('releases a mature held reward exactly once and keeps the account and PointLog consistent', async () => {
    await setConfig('registerReward', 321)
    const user = await registerThenVerify('release-once@test.local')
    const reward = await prisma.growthReward.findFirstOrThrow({
      where: { recipientUserId: user.id, kind: 'registration' },
    })
    await prisma.growthReward.update({
      where: { id: reward.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    })

    await expect(releaseMatureGrowthRewards()).resolves.toEqual([
      { outcome: 'granted', rewardId: reward.id },
    ])
    await expect(releaseMatureGrowthRewards()).resolves.toEqual([])
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: reward.id } })).resolves.toMatchObject({
      state: 'granted',
      grantedAt: expect.any(Date),
    })
    await expect(prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).resolves.toMatchObject({
      balance: 321,
    })
    await expect(prisma.pointLog.findMany({ where: { userId: user.id } })).resolves.toEqual([
      expect.objectContaining({ type: 'in', amount: 321, balanceAfter: 321 }),
    ])
    await expect(voidGrowthReward({ rewardId: reward.id, reason: 'admin_void', caseRef: 'RAP-101' }))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
  })

  it('serializes a racing cron release and admin void without duplicate credit', async () => {
    await setConfig('registerReward', 222)
    const user = await registerThenVerify('release-void-race@test.local')
    const reward = await prisma.growthReward.findFirstOrThrow({
      where: { recipientUserId: user.id, kind: 'registration' },
    })
    await prisma.growthReward.update({
      where: { id: reward.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    })

    const [release, voidResult] = await Promise.allSettled([
      releaseMatureGrowthRewards(),
      voidGrowthReward({ rewardId: reward.id, reason: 'admin_void', caseRef: 'RAP-102' }),
    ])
    expect([release.status, voidResult.status]).toContain('fulfilled')

    const finalReward = await prisma.growthReward.findUniqueOrThrow({ where: { id: reward.id } })
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    const logs = await prisma.pointLog.findMany({ where: { userId: user.id } })
    if (finalReward.state === 'granted') {
      expect(account.balance).toBe(222)
      expect(logs).toHaveLength(1)
    } else {
      expect(finalReward.state).toBe('voided')
      expect(account.balance).toBe(0)
      expect(logs).toHaveLength(0)
    }
  })

  it('rolls an entire selected batch back when any reward cannot be accounted', async () => {
    const good = await createTestUser('batch-rollback-good@test.local', 'pass123', 'user', 0)
    const broken = await prisma.user.create({
      data: { email: 'batch-rollback-broken@test.local', password: 'test-password' },
    })
    await prisma.user.update({ where: { id: good.user.id }, data: { emailVerified: new Date() } })
    await prisma.user.update({ where: { id: broken.id }, data: { emailVerified: new Date() } })
    const matureAt = new Date(Date.now() - 1_000)
    const goodReward = await prisma.growthReward.create({
      data: {
        recipientUserId: good.user.id,
        kind: 'registration',
        amount: 100,
        state: 'held',
        availableAt: matureAt,
        dedupeKey: `batch-good:${good.user.id}`,
      },
    })
    await prisma.growthReward.create({
      data: {
        recipientUserId: broken.id,
        kind: 'registration',
        amount: 100,
        state: 'held',
        availableAt: matureAt,
        dedupeKey: `batch-broken:${broken.id}`,
      },
    })

    await expect(releaseMatureGrowthRewards()).rejects.toBeTruthy()
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: goodReward.id } })).resolves.toMatchObject({
      state: 'held',
      grantedAt: null,
    })
    await expect(prisma.pointAccount.findUniqueOrThrow({ where: { userId: good.user.id } })).resolves.toMatchObject({
      balance: 0,
    })
    expect(await prisma.pointLog.count({ where: { userId: good.user.id } })).toBe(1)
  })

  it('runs the 90-day abuse-event cleanup through the cron lifecycle without touching recent events', async () => {
    const oldEvent = await prisma.abuseEvent.create({
      data: {
        type: 'registration_rejected',
        createdAt: new Date(Date.now() - 91 * DAY_MS),
      },
    })
    const recentEvent = await prisma.abuseEvent.create({
      data: { type: 'registration_rejected', createdAt: new Date() },
    })

    await __runGrowthRewardCronTickForTests()
    expect(await prisma.abuseEvent.findUnique({ where: { id: oldEvent.id } })).toBeNull()
    await expect(prisma.abuseEvent.findUniqueOrThrow({ where: { id: recentEvent.id } })).resolves.toMatchObject({
      type: 'registration_rejected',
    })
  })
})
