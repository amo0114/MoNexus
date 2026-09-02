import pino from 'pino'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChallenge, extractParams, solveChallenge } from 'altcha-lib/v1'
import { api } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { loggerRedact } from '../lib/logger.js'
import { __resetRedisForTests, __setRedisForTests, type RedisLike } from '../lib/redis.js'
import {
  ALTCHA_PROTOCOL_VERSION,
  HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES,
  __resetHumanVerifierForTesting,
  createAltchaHumanVerifier,
  issueAltchaChallenge,
  resolveHumanVerificationPayload,
  type AltchaChallenge,
  type AltchaNonceConsumeResult,
} from '../modules/auth/humanVerification.js'
import { consumeHumanChallengeIssue } from '../modules/auth/abusePolicy.js'
import { HUMAN_CHALLENGE_ISSUE_BUCKETS } from '../modules/auth/abusePolicy.js'

const HMAC_KEY = Buffer.alloc(32, 13).toString('base64')
const HASH_KEY = Buffer.alloc(32, 7)
const REGISTRATION_KEY = 'registrationEnabled'

class NonceRedis implements RedisLike {
  status = 'ready'
  readonly store = new Map<string, { value: string; expiresAt: number }>()
  readonly counts = new Map<string, number>()
  readonly setCalls: Array<{ key: string; args: unknown[] }> = []
  evalCalls = 0
  now = 1_700_000_000_000
  forced: Array<[number, number]> = []

  async get(key: string) {
    const entry = this.store.get(key)
    if (!entry || entry.expiresAt <= this.now) return null
    return entry.value
  }

  async set(key: string, value: string, ...args: unknown[]) {
    this.setCalls.push({ key, args })
    const tokens = args.map(String)
    const nx = tokens.includes('NX')
    const exIdx = tokens.indexOf('EX')
    const ttlSec = exIdx >= 0 ? Number(tokens[exIdx + 1]) : 120
    if (nx) {
      const existing = this.store.get(key)
      if (existing && existing.expiresAt > this.now) return null
    }
    this.store.set(key, { value, expiresAt: this.now + ttlSec * 1_000 })
    return 'OK'
  }

  async del() { return 0 }
  async incr() { return 1 }
  async ping() { return 'PONG' }

  async eval(_script: string, _numberOfKeys: number, key: string, rawTtl: string) {
    this.evalCalls += 1
    const forced = this.forced.shift()
    if (forced) return forced
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return [count, Number(rawTtl)]
  }
}

type ProtectionSnapshot = {
  mode: typeof config.abuseProtectionMode
  hashKey: typeof config.abuseHashKey
  redisEnabled: typeof config.redisEnabled
  redisRequired: typeof config.redisRequired
  cacheKeyPrefix: typeof config.cacheKeyPrefix
  provider: typeof config.humanVerificationProvider
  altchaHmacKey: typeof config.altcha.hmacKey
  maxNumber: typeof config.altcha.maxNumber
  challengeTtlSec: typeof config.altcha.challengeTtlSec
}

let originalConfig: ProtectionSnapshot
let redis: NonceRedis

function snapshotConfig(): ProtectionSnapshot {
  return {
    mode: config.abuseProtectionMode,
    hashKey: config.abuseHashKey,
    redisEnabled: config.redisEnabled,
    redisRequired: config.redisRequired,
    cacheKeyPrefix: config.cacheKeyPrefix,
    provider: config.humanVerificationProvider,
    altchaHmacKey: config.altcha.hmacKey,
    maxNumber: config.altcha.maxNumber,
    challengeTtlSec: config.altcha.challengeTtlSec,
  }
}

function restoreConfig(snapshot: ProtectionSnapshot) {
  config.abuseProtectionMode = snapshot.mode
  config.abuseHashKey = snapshot.hashKey
  config.redisEnabled = snapshot.redisEnabled
  config.redisRequired = snapshot.redisRequired
  config.cacheKeyPrefix = snapshot.cacheKeyPrefix
  config.humanVerificationProvider = snapshot.provider
  config.altcha.hmacKey = snapshot.altchaHmacKey
  config.altcha.maxNumber = snapshot.maxNumber
  config.altcha.challengeTtlSec = snapshot.challengeTtlSec
}

function enableAltchaProtection() {
  config.abuseProtectionMode = 'enforce'
  config.abuseHashKey = HASH_KEY
  config.redisEnabled = true
  config.redisRequired = true
  config.cacheKeyPrefix = 'rap-altcha-test'
  config.humanVerificationProvider = 'altcha'
  config.altcha.hmacKey = Buffer.from(HMAC_KEY, 'base64')
  config.altcha.maxNumber = 1_000
  config.altcha.challengeTtlSec = 120
}

async function solveToPayload(challenge: AltchaChallenge): Promise<string> {
  const { promise } = solveChallenge(
    challenge.challenge,
    challenge.salt,
    challenge.algorithm,
    challenge.maxnumber,
  )
  const solution = await promise
  expect(solution).not.toBeNull()
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number: solution!.number,
    salt: challenge.salt,
    signature: challenge.signature,
  })).toString('base64')
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
    .info(payload, 'altcha-redaction-test')
  return JSON.parse(line) as Record<string, unknown>
}

describe('ALTCHA human verification', () => {
  beforeEach(async () => {
    originalConfig = snapshotConfig()
    redis = new NonceRedis()
    __setRedisForTests(redis)
    enableAltchaProtection()
    await prisma.systemConfig.deleteMany({ where: { key: REGISTRATION_KEY } })
  })

  afterEach(async () => {
    restoreConfig(originalConfig)
    __resetRedisForTests()
    __resetHumanVerifierForTesting()
    await prisma.systemConfig.deleteMany({ where: { key: REGISTRATION_KEY } })
  })

  it('exposes the altcha challenge descriptor without secrets', async () => {
    const res = await api.get('/api/auth/registration-status').expect(200)
    expect(res.body.challenge).toEqual({
      provider: 'altcha',
      challengeUrl: '/api/auth/human-challenge?action=register',
    })
    expect(JSON.stringify(res.body)).not.toContain(HMAC_KEY)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('mints a SHA-256 challenge bound to a server enum action', async () => {
    const res = await api.get('/api/auth/human-challenge?action=register').expect(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.algorithm).toBe('SHA-256')
    expect(res.body).toEqual({
      algorithm: 'SHA-256',
      challenge: expect.any(String),
      maxnumber: 1_000,
      salt: expect.any(String),
      signature: expect.any(String),
    })
    expect(res.body).not.toHaveProperty('number')
    expect(JSON.stringify(res.body)).not.toContain(HMAC_KEY)
    const params = extractParams(res.body)
    expect(params.action).toBe('register')
    expect(params.version).toBe(ALTCHA_PROTOCOL_VERSION)
    expect(params.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(params.expires).toMatch(/^[0-9]+$/)
  })

  it('rejects client-supplied algorithm, difficulty, callback, or unknown action', async () => {
    await api.get('/api/auth/human-challenge?action=login').expect(400)
    await api.get('/api/auth/human-challenge?action=register&algorithm=SHA-1').expect(400)
    await api.get('/api/auth/human-challenge?action=register&maxnumber=1').expect(400)
    await api.get('/api/auth/human-challenge?action=register&callback=https://evil.example').expect(400)
  })

  it('accepts an official-lib golden-path proof for register', async () => {
    const verifier = createAltchaHumanVerifier({ hmacKey: HMAC_KEY, hashKey: HASH_KEY, maxNumber: 1_000 })
    const issued = await issueAltchaChallenge('register', { hmacKey: HMAC_KEY, maxNumber: 1_000 })
    if ('kind' in issued) throw new Error('challenge unavailable')
    const payload = await solveToPayload(issued)

    await expect(verifier.verify({ payload, ip: '203.0.113.40', action: 'register' })).resolves.toEqual({
      kind: 'verified',
    })
    expect(redis.setCalls.some(call => call.args.map(String).includes('NX'))).toBe(true)
    expect(JSON.stringify(redis.setCalls)).not.toContain(payload)
  })

  it('rejects HMAC tamper, expiry, wrong action, oversized, and malformed proofs without consuming a nonce', async () => {
    const verifier = createAltchaHumanVerifier({ hmacKey: HMAC_KEY, hashKey: HASH_KEY, maxNumber: 1_000 })
    const issued = await issueAltchaChallenge('register', { hmacKey: HMAC_KEY, maxNumber: 1_000 })
    if ('kind' in issued) throw new Error('challenge unavailable')
    const payload = await solveToPayload(issued)
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>

    const tampered = Buffer.from(JSON.stringify({ ...parsed, signature: '00'.repeat(32) })).toString('base64')
    await expect(verifier.verify({ payload: tampered, ip: undefined, action: 'register' })).resolves.toEqual({
      kind: 'rejected',
    })

    await expect(verifier.verify({ payload, ip: undefined, action: 'forgot_password' })).resolves.toEqual({
      kind: 'rejected',
    })

    const expired = await createChallenge({
      algorithm: 'SHA-256',
      hmacKey: HMAC_KEY,
      maxNumber: 1_000,
      saltLength: 16,
      expires: new Date(Date.now() - 1_000),
      params: { nonce: 'ab'.repeat(16), action: 'register', version: ALTCHA_PROTOCOL_VERSION },
    })
    const expiredPayload = await solveToPayload({
      algorithm: 'SHA-256',
      challenge: expired.challenge,
      maxnumber: expired.maxnumber ?? 1_000,
      salt: expired.salt,
      signature: expired.signature,
    })
    await expect(verifier.verify({ payload: expiredPayload, ip: undefined, action: 'register' })).resolves.toEqual({
      kind: 'rejected',
    })

    await expect(verifier.verify({ payload: '{not-json', ip: undefined, action: 'register' })).resolves.toEqual({
      kind: 'rejected',
    })
    await expect(verifier.verify({
      payload: 'a'.repeat(HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES + 1),
      ip: undefined,
      action: 'register',
    })).resolves.toEqual({ kind: 'rejected' })

    expect(redis.setCalls).toHaveLength(0)
  })

  it('consumes a valid nonce only once under concurrent replay', async () => {
    const consumed: string[] = []
    const verifier = createAltchaHumanVerifier({
      hmacKey: HMAC_KEY,
      hashKey: HASH_KEY,
      maxNumber: 1_000,
      consumeNonce: async (nonce) => {
        if (consumed.includes(nonce)) return 'replay'
        consumed.push(nonce)
        return 'consumed'
      },
    })
    const issued = await issueAltchaChallenge('register', { hmacKey: HMAC_KEY, maxNumber: 1_000 })
    if ('kind' in issued) throw new Error('challenge unavailable')
    const payload = await solveToPayload(issued)

    const results = await Promise.all([
      verifier.verify({ payload, ip: undefined, action: 'register' }),
      verifier.verify({ payload, ip: undefined, action: 'register' }),
    ])
    expect(results.filter(result => result.kind === 'verified')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'rejected')).toHaveLength(1)
    expect(consumed).toHaveLength(1)
  })

  it('maps missing, mismatched provider, failed, and unavailable proofs to 400/403/503', async () => {
    const missing = await api.post('/api/auth/register').send({
      email: 'altcha-missing@test.local', password: 'pass123',
    }).expect(400)
    expect(missing.body.error.code).toBe('HUMAN_VERIFICATION_REQUIRED')

    const legacy = await api.post('/api/auth/register').send({
      email: 'altcha-legacy@test.local', password: 'pass123', turnstileToken: 'old-turnstile-proof',
    }).expect(400)
    expect(legacy.body.error.code).toBe('HUMAN_VERIFICATION_REQUIRED')

    const weaker = await api.post('/api/auth/register').send({
      email: 'altcha-weaker@test.local',
      password: 'pass123',
      humanVerification: { provider: 'turnstile', payload: 'turnstile-proof' },
    }).expect(403)
    expect(weaker.body.error.code).toBe('HUMAN_VERIFICATION_FAILED')

    const oversized = await api.post('/api/auth/register').send({
      email: 'altcha-oversize@test.local',
      password: 'pass123',
      humanVerification: { provider: 'altcha', payload: 'a'.repeat(HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES + 1) },
    }).expect(400)
    expect(oversized.body.error.code).toBe('VALIDATION_ERROR')

    const malformed = await api.post('/api/auth/register').send({
      email: 'altcha-malformed@test.local',
      password: 'pass123',
      humanVerification: { provider: 'altcha', payload: 'not-a-proof' },
    }).expect(403)
    expect(malformed.body.error.code).toBe('HUMAN_VERIFICATION_FAILED')
    expect(await prisma.user.findUnique({ where: { email: 'altcha-malformed@test.local' } })).toBeNull()
  })

  it('registers only after switch, preflight, proof, and attempt buckets', async () => {
    const challengeRes = await api.get('/api/auth/human-challenge?action=register').expect(200)
    const payload = await solveToPayload(challengeRes.body)
    const evalsBeforeProof = redis.evalCalls

    const accepted = await api.post('/api/auth/register').send({
      email: 'altcha-success@test.local',
      password: 'pass123',
      humanVerification: { provider: 'altcha', payload },
    }).expect(201)
    expect(accepted.body.user.email).toBe('altcha-success@test.local')
    expect(redis.evalCalls).toBeGreaterThan(evalsBeforeProof)
    expect(redis.setCalls.length).toBeGreaterThan(0)

    const replay = await api.post('/api/auth/register').send({
      email: 'altcha-replay@test.local',
      password: 'pass123',
      humanVerification: { provider: 'altcha', payload },
    }).expect(403)
    expect(replay.body.error.code).toBe('HUMAN_VERIFICATION_FAILED')
    expect(await prisma.user.findUnique({ where: { email: 'altcha-replay@test.local' } })).toBeNull()
  })

  it('returns 503 when Redis is down and does not leak internals', async () => {
    __setRedisForTests(null)
    const mint = await api.get('/api/auth/human-challenge?action=register').expect(503)
    expect(mint.body.error.code).toBe('ABUSE_PROTECTION_UNAVAILABLE')
    expect(JSON.stringify(mint.body)).not.toContain('redis')

    const issued = await issueAltchaChallenge('register', { hmacKey: HMAC_KEY, maxNumber: 1_000 })
    if ('kind' in issued) throw new Error('challenge unavailable')
    const payload = await solveToPayload(issued)
    const register = await api.post('/api/auth/register').send({
      email: 'altcha-redis-down@test.local',
      password: 'pass123',
      humanVerification: { provider: 'altcha', payload },
    }).expect(503)
    expect(['ABUSE_PROTECTION_UNAVAILABLE', 'HUMAN_VERIFICATION_UNAVAILABLE']).toContain(register.body.error.code)
    expect(JSON.stringify(register.body)).not.toContain(payload)
    expect(JSON.stringify(register.body)).not.toContain(HMAC_KEY)
  })

  it('encodes independent human-challenge issue quotas', async () => {
    expect(HUMAN_CHALLENGE_ISSUE_BUCKETS.map(bucket => [bucket.flow, bucket.dimension, bucket.limit, bucket.windowMs])).toEqual([
      ['human-challenge', 'ip', 30, 60_000],
      ['human-challenge', 'ip', 120, 600_000],
    ])
    const result = await consumeHumanChallengeIssue('203.0.113.41')
    expect(result.allowed).toBe(true)
  })

  it('redacts ALTCHA proof and HMAC key from structured logs', () => {
    const canary = 'altcha-sensitive-canary-value'
    const logged = serializeLog({
      code: 'HUMAN_VERIFICATION_FAILED',
      ALTCHA_HMAC_KEY: canary,
      humanVerification: { provider: 'altcha', payload: canary },
      req: { body: { humanVerification: { provider: 'altcha', payload: canary } } },
      config: { altcha: { hmacKey: canary } },
    })
    expect(JSON.stringify(logged).includes(canary)).toBe(false)
    expect(logged.code).toBe('HUMAN_VERIFICATION_FAILED')
  })

  it('does not let a client pick turnstile after the provider switched to altcha', () => {
    expect(resolveHumanVerificationPayload(
      { turnstileToken: 'legacy' },
      'altcha',
    )).toEqual({ missing: true })
    expect(resolveHumanVerificationPayload(
      { humanVerification: { provider: 'turnstile', payload: 'x' } },
      'altcha',
    )).toEqual({ rejected: true })
    expect(resolveHumanVerificationPayload(
      { humanVerification: { provider: 'altcha', payload: 'proof' }, turnstileToken: 'legacy' },
      'altcha',
    )).toEqual({ payload: 'proof' })
    expect(resolveHumanVerificationPayload(
      { turnstileToken: 'legacy' },
      'turnstile',
    )).toEqual({ payload: 'legacy' })
  })
})

describe('ALTCHA nonce consume typing', () => {
  it('treats only NX success as consumed', async () => {
    const results: AltchaNonceConsumeResult[] = []
    const seen = new Set<string>()
    const consume = async (nonce: string): Promise<AltchaNonceConsumeResult> => {
      if (seen.has(nonce)) return 'replay'
      seen.add(nonce)
      results.push('consumed')
      return 'consumed'
    }
    expect(await consume('abc')).toBe('consumed')
    expect(await consume('abc')).toBe('replay')
    expect(results).toEqual(['consumed'])
  })
})
