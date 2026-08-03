import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { __resetRedisForTests, __setRedisForTests, type RedisLike } from '../lib/redis.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting, type Mailer } from '../lib/mailer/index.js'
import {
  __resetHumanVerifierForTesting,
  __setHumanVerifierForTesting,
  type HumanVerificationResult,
} from '../modules/auth/humanVerification.js'

const REGISTRATION_KEY = 'registrationEnabled'

class CountingRedis implements RedisLike {
  status = 'ready'
  readonly counts = new Map<string, number>()
  readonly forced: Array<[number, number]> = []

  async get() { return null }
  async set() { return 'OK' }
  async del() { return 0 }
  async incr() { return 1 }
  async ping() { return 'PONG' }

  async eval(_script: string, _numberOfKeys: number, key: string, rawTtl: string, ..._rest: string[]) {
    const forced = this.forced.shift()
    if (forced) return forced
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return [count, Number(rawTtl)]
  }
}

class FailingMailer implements Mailer {
  async send(_message: Parameters<Mailer['send']>[0]): Promise<void> {
    throw new Error('smtp failure must not be exposed')
  }
}

type ProtectionConfigSnapshot = {
  mode: typeof config.abuseProtectionMode
  hashKey: typeof config.abuseHashKey
  redisEnabled: typeof config.redisEnabled
  redisRequired: typeof config.redisRequired
  cacheKeyPrefix: typeof config.cacheKeyPrefix
  siteKey: typeof config.turnstile.siteKey
  secretKey: typeof config.turnstile.secretKey
  allowedHostnames: typeof config.turnstile.allowedHostnames
}

let originalConfig: ProtectionConfigSnapshot

function snapshotProtectionConfig(): ProtectionConfigSnapshot {
  return {
    mode: config.abuseProtectionMode,
    hashKey: config.abuseHashKey,
    redisEnabled: config.redisEnabled,
    redisRequired: config.redisRequired,
    cacheKeyPrefix: config.cacheKeyPrefix,
    siteKey: config.turnstile.siteKey,
    secretKey: config.turnstile.secretKey,
    allowedHostnames: [...config.turnstile.allowedHostnames],
  }
}

function restoreProtectionConfig(snapshot: ProtectionConfigSnapshot) {
  config.abuseProtectionMode = snapshot.mode
  config.abuseHashKey = snapshot.hashKey
  config.redisEnabled = snapshot.redisEnabled
  config.redisRequired = snapshot.redisRequired
  config.cacheKeyPrefix = snapshot.cacheKeyPrefix
  config.turnstile.siteKey = snapshot.siteKey
  config.turnstile.secretKey = snapshot.secretKey
  config.turnstile.allowedHostnames = [...snapshot.allowedHostnames]
}

function enableProtection() {
  config.abuseProtectionMode = 'enforce'
  config.abuseHashKey = Buffer.alloc(32, 7)
  config.redisEnabled = true
  config.redisRequired = true
  config.cacheKeyPrefix = 'rap-auth-test'
  config.turnstile.siteKey = 'public-test-site-key'
  config.turnstile.secretKey = 'private-test-secret'
  config.turnstile.allowedHostnames = ['localhost']
}

async function clearRegistrationSwitch() {
  await prisma.systemConfig.deleteMany({ where: { key: REGISTRATION_KEY } })
}

async function sideEffectSnapshot() {
  const [users, pointAccounts, pointLogs, inviteRelations, growthRewards, refreshTokens] = await Promise.all([
    prisma.user.count(),
    prisma.pointAccount.count(),
    prisma.pointLog.count(),
    prisma.inviteRelation.count(),
    prisma.growthReward.count(),
    prisma.refreshToken.count(),
  ])
  return { users, pointAccounts, pointLogs, inviteRelations, growthRewards, refreshTokens }
}

describe('SPEC-RAP-001 auth registration/mail integration', () => {
  beforeEach(async () => {
    originalConfig = snapshotProtectionConfig()
    await clearRegistrationSwitch()
    __setMailerForTesting(new CaptureMailer())
  })

  afterEach(async () => {
    await clearRegistrationSwitch()
    restoreProtectionConfig(originalConfig)
    __resetRedisForTests()
    __resetHumanVerifierForTesting()
    __setMailerForTesting(null)
  })

  it('exposes only the safe challenge descriptor when protection is ready', async () => {
    enableProtection()
    const res = await api.get('/api/auth/registration-status').expect(200)

    expect(res.body).toEqual({
      registrationEnabled: true,
      registrationAvailable: true,
      inviteRequired: false,
      challenge: { provider: 'turnstile', siteKey: 'public-test-site-key' },
    })
    expect(JSON.stringify(res.body)).not.toContain('private-test-secret')
    expect(JSON.stringify(res.body)).not.toContain('localhost')

    config.redisRequired = false
    const unavailable = await api.get('/api/auth/registration-status').expect(200)
    expect(unavailable.body).toEqual({
      registrationEnabled: true,
      registrationAvailable: false,
      inviteRequired: false,
      challenge: null,
    })
  })

  it('checks the registration gate before validation or abuse dependencies', async () => {
    enableProtection()
    const redis = new CountingRedis()
    __setRedisForTests(redis)
    let verifierCalls = 0
    __setHumanVerifierForTesting({
      verify: async () => {
        verifierCalls += 1
        return { kind: 'verified' }
      },
    })
    await prisma.systemConfig.create({ data: { key: REGISTRATION_KEY, value: 0 } })

    const before = await sideEffectSnapshot()
    const res = await api.post('/api/auth/register').send({
      email: 'blocked-before-validation@test.local',
      password: 'pass123',
      unknownField: 'must-not-reach-validation',
    }).expect(403)

    expect(res.body.error.code).toBe('REGISTRATION_DISABLED')
    expect(redis.counts.size).toBe(0)
    expect(verifierCalls).toBe(0)
    expect(await sideEffectSnapshot()).toEqual(before)
  })

  it('short-circuits provider preflight before Turnstile and all DB/session work', async () => {
    enableProtection()
    const redis = new CountingRedis()
    redis.forced.push([21, 600_000])
    __setRedisForTests(redis)
    let verifierCalls = 0
    __setHumanVerifierForTesting({
      verify: async () => {
        verifierCalls += 1
        return { kind: 'verified' }
      },
    })

    const before = await sideEffectSnapshot()
    const res = await api.post('/api/auth/register').send({
      email: 'preflight-blocked@test.local',
      password: 'pass123',
      turnstileToken: 'proof',
    }).expect(429)

    expect(res.body.error.code).toBe('RATE_LIMITED')
    expect(res.headers['retry-after']).toBe('600')
    expect(verifierCalls).toBe(0)
    expect(await sideEffectSnapshot()).toEqual(before)
  })

  it('maps missing, rejected, unavailable, and post-proof rate-limit states safely', async () => {
    enableProtection()
    const redis = new CountingRedis()
    __setRedisForTests(redis)
    let verification: HumanVerificationResult = { kind: 'verified' }
    __setHumanVerifierForTesting({ verify: async () => verification })

    const missing = await api.post('/api/auth/register').send({
      email: 'missing-proof@test.local', password: 'pass123',
    }).expect(400)
    expect(missing.body.error.code).toBe('HUMAN_VERIFICATION_REQUIRED')

    verification = { kind: 'rejected' }
    const rejected = await api.post('/api/auth/register').send({
      email: 'rejected-proof@test.local', password: 'pass123', turnstileToken: 'bad-proof',
    }).expect(403)
    expect(rejected.body.error.code).toBe('HUMAN_VERIFICATION_FAILED')

    verification = { kind: 'unavailable' }
    const unavailable = await api.post('/api/auth/register').send({
      email: 'unavailable-proof@test.local', password: 'pass123', turnstileToken: 'proof',
    }).expect(503)
    expect(unavailable.body.error.code).toBe('HUMAN_VERIFICATION_UNAVAILABLE')

    verification = { kind: 'verified' }
    // Each request consumes one provider preflight key. The next response is
    // the first full registration bucket and must stop before bcrypt/DB.
    redis.forced.push([1, 600_000], [6, 3_600_000])
    const limited = await api.post('/api/auth/register').send({
      email: 'full-bucket-blocked@test.local', password: 'pass123', turnstileToken: 'proof',
    }).expect(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    expect(await prisma.user.findUnique({ where: { email: 'full-bucket-blocked@test.local' } })).toBeNull()
  })

  it('fails closed on Redis and permits a verified registration only after all checks', async () => {
    enableProtection()
    __setHumanVerifierForTesting({ verify: async () => ({ kind: 'verified' }) })
    __setRedisForTests(null)

    const before = await sideEffectSnapshot()
    const unavailable = await api.post('/api/auth/register').send({
      email: 'redis-down@test.local', password: 'pass123', turnstileToken: 'proof',
    }).expect(503)
    expect(unavailable.body.error.code).toBe('ABUSE_PROTECTION_UNAVAILABLE')
    expect(await sideEffectSnapshot()).toEqual(before)

    const redis = new CountingRedis()
    __setRedisForTests(redis)
    const accepted = await api.post('/api/auth/register').send({
      email: 'protected-success@test.local', password: 'pass123', turnstileToken: 'proof',
    }).expect(201)
    expect(accepted.body.user.email).toBe('protected-success@test.local')
  })

  it('does not create verification tokens or mail when a user-mail bucket denies', async () => {
    enableProtection()
    const redis = new CountingRedis()
    redis.forced.push([2, 60_000])
    __setRedisForTests(redis)
    const mailer = new CaptureMailer()
    __setMailerForTesting(mailer)
    const { user, password } = await createTestUser('verify-limited@test.local')
    const { accessToken } = await loginAs(user.email, password)

    const res = await api.post('/api/auth/send-verification').set(authHeader(accessToken)).expect(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
    expect(await prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBe(0)
    expect(mailer.sent).toHaveLength(0)
  })

  it('fails closed for verification mail when Redis is unavailable', async () => {
    enableProtection()
    __setRedisForTests(null)
    const mailer = new CaptureMailer()
    __setMailerForTesting(mailer)
    const { user, password } = await createTestUser('verify-redis-down@test.local')
    const { accessToken } = await loginAs(user.email, password)

    const res = await api.post('/api/auth/send-verification').set(authHeader(accessToken)).expect(503)
    expect(res.body.error.code).toBe('ABUSE_PROTECTION_UNAVAILABLE')
    expect(await prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBe(0)
    expect(mailer.sent).toHaveLength(0)
  })

  it('keeps password reset responses generic for unknown, throttled, Redis-down, and SMTP errors', async () => {
    const unknown = await api.post('/api/auth/forgot-password').send({ email: 'unknown-reset@test.local' }).expect(200)

    const { user } = await createTestUser('known-reset-generic@test.local')
    const known = await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    expect(known.body).toEqual(unknown.body)

    enableProtection()
    const limitedRedis = new CountingRedis()
    limitedRedis.forced.push([2, 60_000])
    __setRedisForTests(limitedRedis)
    const throttled = await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    expect(throttled.body).toEqual(unknown.body)
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1)

    __setRedisForTests(null)
    const redisDown = await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    expect(redisDown.body).toEqual(unknown.body)

    __setRedisForTests(new CountingRedis())
    const failingMailer = new FailingMailer()
    __setMailerForTesting(failingMailer)
    const smtpFailure = await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    expect(smtpFailure.body).toEqual(unknown.body)
  })
})
