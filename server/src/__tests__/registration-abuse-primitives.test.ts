import pino from 'pino'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ABUSE_LIMITER_LUA,
  AbuseProtectionUnavailableError,
  buildAbuseLimiterKey,
  createAbuseLimiter,
  type AbuseLimiter,
  type AbuseLimiterBucket,
} from '../lib/abuseLimiter.js'
import {
  abuseProtectionUnavailable,
  emailVerificationRequired,
  humanVerificationFailed,
  humanVerificationRequired,
  humanVerificationUnavailable,
} from '../lib/httpError.js'
import { loggerRedact } from '../lib/logger.js'
import { __resetRedisForTests, __setRedisForTests } from '../lib/redis.js'
import {
  __resetHumanVerifierForTesting,
  __setHumanVerifierForTesting,
  createTurnstileHumanVerifier,
  getHumanVerifier,
  TURNSTILE_SITEVERIFY_ENDPOINT,
  TURNSTILE_TIMEOUT_MS,
  type HumanVerifier,
} from '../modules/auth/humanVerification.js'
import {
  consumeAbusePolicy,
  consumePasswordReset,
  consumePendingReferralRelation,
  consumeRegistrationAttempt,
  consumeRegistrationProviderPreflight,
  consumeVerificationEmailSend,
  getShanghaiDayWindow,
} from '../modules/auth/abusePolicy.js'

const HASH_KEY = Buffer.alloc(32, 9)

class FakeLuaRedis {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>()
  readonly evalCalls: Array<{ script: string; numberOfKeys: number; args: string[] }> = []
  now = 1_000

  async get() {
    return null
  }

  async set() {
    return 'OK'
  }

  async del() {
    return 0
  }

  async incr() {
    return 1
  }

  async ping() {
    return 'PONG'
  }

  async eval(script: string, numberOfKeys: number, ...args: string[]) {
    this.evalCalls.push({ script, numberOfKeys, args })
    if (script !== ABUSE_LIMITER_LUA || numberOfKeys !== 1 || args.length !== 2) {
      throw new Error('unexpected Lua invocation')
    }

    const [key, rawTtl] = args
    const ttlMs = Number(rawTtl)
    if (!key || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('invalid Lua args')

    const existing = this.counters.get(key)
    const entry = existing && existing.expiresAt > this.now
      ? existing
      : { count: 0, expiresAt: this.now + ttlMs }
    entry.count += 1
    this.counters.set(key, entry)

    return [entry.count, Math.max(0, entry.expiresAt - this.now)]
  }

  advance(ms: number) {
    this.now += ms
  }
}

const TEST_BUCKET: AbuseLimiterBucket = {
  flow: 'registration',
  dimension: 'ip',
  limit: 3,
  windowMs: 60_000,
}

function createTestLimiter() {
  return createAbuseLimiter({ cacheKeyPrefix: 'rap-test', hashKey: HASH_KEY })
}

class RecordingLimiter implements AbuseLimiter {
  readonly calls: Array<{ bucket: AbuseLimiterBucket; subject: string | number }> = []

  constructor(private readonly results: Array<{ allowed: boolean; retryAfterSeconds: number }> = []) {}

  async consume(bucket: AbuseLimiterBucket, subject: string | number) {
    this.calls.push({ bucket, subject })
    return this.results.shift() ?? { allowed: true, retryAfterSeconds: 0 }
  }
}

function serializeLog(payload: Record<string, unknown>) {
  let line = ''
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      line += chunk.toString()
      callback()
    },
  })
  pino({ base: undefined, timestamp: false, redact: loggerRedact }, destination)
    .info(payload, 'registration-abuse-redaction-test')
  return JSON.parse(line) as Record<string, unknown>
}

describe('SPEC-RAP-001 security primitives', () => {
  let redis: FakeLuaRedis

  beforeEach(() => {
    redis = new FakeLuaRedis()
    __setRedisForTests(redis)
  })

  afterEach(() => {
    __resetRedisForTests()
    __resetHumanVerifierForTesting()
  })

  it('uses one Lua INCR + initial PEXPIRE + PTTL transition and never exceeds the bucket limit', async () => {
    const limiter = createTestLimiter()
    const results = await Promise.all(Array.from({ length: 12 }, () => limiter.consume(TEST_BUCKET, '203.0.113.15')))

    expect(results.filter(result => result.allowed)).toHaveLength(3)
    expect(results.filter(result => !result.allowed).every(result => result.retryAfterSeconds === 60)).toBe(true)
    expect(redis.evalCalls).toHaveLength(12)
    expect(redis.evalCalls.every(call => (
      call.script.includes("redis.call('INCR'")
      && call.script.includes("redis.call('PEXPIRE'")
      && call.script.includes("redis.call('PTTL'")
      && call.numberOfKeys === 1
    ))).toBe(true)
  })

  it('resets a key only after its fixed TTL and returns a safe rounded retry delay', async () => {
    const limiter = createTestLimiter()

    await limiter.consume(TEST_BUCKET, '203.0.113.16')
    await limiter.consume(TEST_BUCKET, '203.0.113.16')
    await limiter.consume(TEST_BUCKET, '203.0.113.16')
    redis.advance(59_001)
    await expect(limiter.consume(TEST_BUCKET, '203.0.113.16')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    })

    redis.advance(999)
    await expect(limiter.consume(TEST_BUCKET, '203.0.113.16')).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    })
  })

  it('uses HMAC-derived keys for email/IP and only numeric identifiers for user-like dimensions', () => {
    const emailBucket: AbuseLimiterBucket = { ...TEST_BUCKET, dimension: 'email' }
    const emailKey = buildAbuseLimiterKey(emailBucket, ' User@Example.COM ', {
      cacheKeyPrefix: 'rap-test',
      hashKey: HASH_KEY,
    })
    const ipKey = buildAbuseLimiterKey(TEST_BUCKET, '203.0.113.17', {
      cacheKeyPrefix: 'rap-test',
      hashKey: HASH_KEY,
    })
    const userKey = buildAbuseLimiterKey(
      { ...TEST_BUCKET, flow: 'verification-email', dimension: 'user' },
      42,
      { cacheKeyPrefix: 'rap-test', hashKey: HASH_KEY },
    )

    expect(emailKey.includes('User@Example.COM') || emailKey.includes('user@example.com')).toBe(false)
    expect(ipKey.includes('203.0.113.17')).toBe(false)
    expect(userKey.endsWith(':42:60000')).toBe(true)
    expect(emailKey).toContain(':abuse:v1:registration:email:')
  })

  it('fails closed for a missing Redis client, malformed Lua result, or executor failure', async () => {
    __setRedisForTests(null)
    await expect(createTestLimiter().consume(TEST_BUCKET, '203.0.113.18')).rejects.toBeInstanceOf(
      AbuseProtectionUnavailableError,
    )

    const malformed = createAbuseLimiter({
      cacheKeyPrefix: 'rap-test',
      hashKey: HASH_KEY,
      executeLua: async () => ['not-a-count', -1],
    })
    await expect(malformed.consume(TEST_BUCKET, '203.0.113.18')).rejects.toBeInstanceOf(
      AbuseProtectionUnavailableError,
    )

    const unavailable = createAbuseLimiter({
      cacheKeyPrefix: 'rap-test',
      hashKey: HASH_KEY,
      executeLua: async () => {
        throw new Error('redis timeout')
      },
    })
    await expect(unavailable.consume(TEST_BUCKET, '203.0.113.18')).rejects.toBeInstanceOf(
      AbuseProtectionUnavailableError,
    )
  })

  it('encodes named registration, mail, and referral policies in the specified order and values', async () => {
    const limiter = new RecordingLimiter()
    await consumeRegistrationProviderPreflight('203.0.113.19', limiter)
    await consumeRegistrationAttempt({ ip: '203.0.113.19', email: 'rate@example.com' }, limiter)
    await consumeVerificationEmailSend({ userId: 7, email: 'rate@example.com', ip: '203.0.113.19' }, limiter)
    await consumePasswordReset({ email: 'rate@example.com', ip: '203.0.113.19' }, limiter)
    await consumePendingReferralRelation(99, {
      limiter,
      now: new Date('2026-08-01T15:59:59.000Z'),
    })

    expect(limiter.calls.map(({ bucket }) => [bucket.flow, bucket.dimension, bucket.limit, bucket.windowMs, bucket.windowKey])).toEqual([
      ['registration-preflight', 'ip', 20, 600_000, undefined],
      ['registration', 'ip', 5, 3_600_000, undefined],
      ['registration', 'ip', 20, 86_400_000, undefined],
      ['registration', 'email', 2, 86_400_000, undefined],
      ['verification-email', 'user', 1, 60_000, undefined],
      ['verification-email', 'user', 5, 86_400_000, undefined],
      ['verification-email', 'email', 1, 60_000, undefined],
      ['verification-email', 'email', 5, 86_400_000, undefined],
      ['verification-email', 'ip', 10, 3_600_000, undefined],
      ['verification-email', 'ip', 30, 86_400_000, undefined],
      ['password-reset', 'email', 1, 60_000, undefined],
      ['password-reset', 'email', 5, 86_400_000, undefined],
      ['password-reset', 'ip', 10, 3_600_000, undefined],
      ['password-reset', 'ip', 30, 86_400_000, undefined],
      ['referral-pending', 'inviter', 6, 1_000, '2026-08-01'],
    ])
  })

  it('short-circuits named policy consumption after the first denied bucket', async () => {
    const limiter = new RecordingLimiter([
      { allowed: true, retryAfterSeconds: 0 },
      { allowed: false, retryAfterSeconds: 42 },
    ])

    await expect(consumeRegistrationAttempt({ ip: '203.0.113.20', email: 'stop@example.com' }, limiter)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 42,
    })
    expect(limiter.calls).toHaveLength(2)
    expect(limiter.calls[1]?.bucket.dimension).toBe('ip')
  })

  it('calculates Shanghai natural-day key and expiry without using server-local time', () => {
    expect(getShanghaiDayWindow(new Date('2026-08-01T15:59:59.000Z'))).toEqual({
      key: '2026-08-01',
      windowMs: 1_000,
    })
    expect(getShanghaiDayWindow(new Date('2026-08-01T16:00:00.000Z'))).toEqual({
      key: '2026-08-02',
      windowMs: 86_400_000,
    })
  })

  it('accepts only a successful register action from an exact allowed Turnstile hostname', async () => {
    let calledUrl = ''
    let calledInit: RequestInit | undefined
    const fetchImplementation: typeof fetch = async (input, init) => {
      calledUrl = String(input)
      calledInit = init
      return new Response(JSON.stringify({ success: true, action: 'register', hostname: 'app.example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const verifier = createTurnstileHumanVerifier({
      secretKey: 'test-turnstile-secret',
      allowedHostnames: ['app.example.com'],
      fetchImplementation,
    })

    await expect(verifier.verifyRegistration({ token: 'test-token', ip: '203.0.113.21' })).resolves.toEqual({ kind: 'verified' })
    expect(calledUrl).toBe(TURNSTILE_SITEVERIFY_ENDPOINT)
    expect(calledInit?.method).toBe('POST')
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal)
    expect(String(calledInit?.body).includes('response=test-token')).toBe(true)
    expect(TURNSTILE_TIMEOUT_MS).toBe(3_000)
  })

  it('rejects valid token failures plus action or hostname mismatches', async () => {
    const cases: unknown[] = [
      { success: false, 'error-codes': ['invalid-input-response'] },
      { success: true, action: 'login', hostname: 'app.example.com' },
      { success: true, action: 'register', hostname: 'other.example.com' },
      { success: true, action: 'register', hostname: 'https://app.example.com' },
    ]

    for (const payload of cases) {
      const verifier = createTurnstileHumanVerifier({
        secretKey: 'test-turnstile-secret',
        allowedHostnames: ['app.example.com'],
        fetchImplementation: async () => new Response(JSON.stringify(payload), { status: 200 }),
      })
      await expect(verifier.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'rejected' })
    }
  })

  it('returns unavailable for config, network, timeout-like, and provider HTTP failures without a bypass', async () => {
    const missingConfig = createTurnstileHumanVerifier({
      secretKey: '',
      allowedHostnames: ['app.example.com'],
      fetchImplementation: async () => new Response('{}', { status: 200 }),
    })
    await expect(missingConfig.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'unavailable' })

    const failureFetch: typeof fetch = async () => {
      throw new DOMException('timeout', 'TimeoutError')
    }
    const networkFailure = createTurnstileHumanVerifier({
      secretKey: 'test-turnstile-secret',
      allowedHostnames: ['app.example.com'],
      fetchImplementation: failureFetch,
    })
    await expect(networkFailure.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'unavailable' })

    const providerFailure = createTurnstileHumanVerifier({
      secretKey: 'test-turnstile-secret',
      allowedHostnames: ['app.example.com'],
      fetchImplementation: async () => new Response('', { status: 500 }),
    })
    await expect(providerFailure.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'unavailable' })

    const malformedJson = createTurnstileHumanVerifier({
      secretKey: 'test-turnstile-secret',
      allowedHostnames: ['app.example.com'],
      fetchImplementation: async () => new Response('not-json', { status: 200 }),
    })
    await expect(malformedJson.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'unavailable' })

    const malformedBody = createTurnstileHumanVerifier({
      secretKey: 'test-turnstile-secret',
      allowedHostnames: ['app.example.com'],
      fetchImplementation: async () => new Response(JSON.stringify({ success: true, action: 'register' }), { status: 200 }),
    })
    await expect(malformedBody.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'unavailable' })

    const providerConfigFailure = createTurnstileHumanVerifier({
      secretKey: 'test-turnstile-secret',
      allowedHostnames: ['app.example.com'],
      fetchImplementation: async () => new Response(JSON.stringify({
        success: false,
        'error-codes': ['invalid-input-secret'],
      }), { status: 200 }),
    })
    await expect(providerConfigFailure.verifyRegistration({ token: 'test-token', ip: undefined })).resolves.toEqual({ kind: 'unavailable' })
  })

  it('permits only explicit test-process verifier injection', async () => {
    const verifier: HumanVerifier = {
      verifyRegistration: async () => ({ kind: 'verified' }),
    }
    __setHumanVerifierForTesting(verifier)
    await expect(getHumanVerifier().verifyRegistration({ token: 'in-memory-test-token', ip: undefined })).resolves.toEqual({
      kind: 'verified',
    })
  })

  it('redacts Turnstile proof, independent HMAC key, and provider request/response containers without hiding error codes', () => {
    const canary = 'rap-sensitive-canary-value'
    const logged = serializeLog({
      code: 'HUMAN_VERIFICATION_FAILED',
      ABUSE_HASH_KEY: canary,
      TURNSTILE_SECRET_KEY: canary,
      config: { abuseHashKey: canary, turnstile: { secretKey: canary } },
      req: { body: { turnstileToken: canary } },
      err: {
        context: {
          siteverify: {
            request: { body: { secret: canary, response: canary } },
            response: { body: { token: canary, errorCodes: ['invalid-input-response'] } },
          },
        },
      },
    })

    expect(JSON.stringify(logged).includes(canary)).toBe(false)
    expect(logged.code).toBe('HUMAN_VERIFICATION_FAILED')
  })

  it('exposes the five RAP error helpers with exact HTTP semantics', () => {
    expect([
      emailVerificationRequired(),
      humanVerificationRequired(),
      humanVerificationFailed(),
      humanVerificationUnavailable(),
      abuseProtectionUnavailable(),
    ].map(error => [error.status, error.code])).toEqual([
      [403, 'EMAIL_VERIFICATION_REQUIRED'],
      [400, 'HUMAN_VERIFICATION_REQUIRED'],
      [403, 'HUMAN_VERIFICATION_FAILED'],
      [503, 'HUMAN_VERIFICATION_UNAVAILABLE'],
      [503, 'ABUSE_PROTECTION_UNAVAILABLE'],
    ])
  })

  it('does not continue an arbitrary policy sequence after a denial', async () => {
    const limiter = new RecordingLimiter([{ allowed: false, retryAfterSeconds: 5 }])
    await expect(consumeAbusePolicy([
      { bucket: TEST_BUCKET, subject: '203.0.113.22' },
      { bucket: { ...TEST_BUCKET, dimension: 'email' }, subject: 'later@example.com' },
    ], limiter)).resolves.toEqual({ allowed: false, retryAfterSeconds: 5 })
    expect(limiter.calls).toHaveLength(1)
  })
})
