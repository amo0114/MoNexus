import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, createTestUser } from './helpers.js'
import { config } from '../config/index.js'
import { ABUSE_LIMITER_LUA } from '../lib/abuseLimiter.js'
import { __resetRedisForTests, __setRedisForTests, type RedisLike } from '../lib/redis.js'
import { __resetHumanVerifierForTesting, __setHumanVerifierForTesting } from '../modules/auth/humanVerification.js'
import type { HumanVerificationAction } from '../modules/auth/humanVerification/types.js'

type Entry = { count: number; expiresAt: number }

// Interprets the three fixed-window scripts by behaviour so lockout state and
// the shared authentication IP bucket evolve like they would in Redis.
class ScriptedRedis implements RedisLike {
  status = 'ready'
  readonly entries = new Map<string, Entry>()

  private live(key: string) {
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt <= Date.now()) this.entries.delete(key)
    return this.entries.get(key)
  }

  async get() { return null }
  async set() { return 'OK' }
  async incr() { return 1 }
  async ping() { return 'PONG' }
  async del(...keys: string[]) {
    let removed = 0
    for (const key of keys) if (this.entries.delete(key)) removed++
    return removed
  }

  async eval(script: string, _numberOfKeys: number, key: string, ...args: string[]) {
    const entry = this.live(key)
    if (script.includes("redis.call('GET'")) return entry?.count ?? 0
    const windowMs = Number(args[0])
    const next = { count: (entry?.count ?? 0) + 1, expiresAt: entry?.expiresAt ?? Date.now() + windowMs }
    if (script === ABUSE_LIMITER_LUA) {
      this.entries.set(key, next)
      return [next.count, next.expiresAt - Date.now()]
    }
    if (next.count === 1 || next.count >= Number(args[1])) next.expiresAt = Date.now() + windowMs
    this.entries.set(key, next)
    return next.count
  }
}

let snapshot: Pick<typeof config, 'abuseProtectionMode' | 'abuseHashKey' | 'redisEnabled' | 'redisRequired' | 'cacheKeyPrefix' | 'humanVerificationProvider'>
let verifierCalls: Array<{ payload: string; action: HumanVerificationAction }>

const PROOF = { provider: 'turnstile' as const, payload: 'valid-proof' }

function login(email: string, password: string, humanVerification?: typeof PROOF | { provider: 'turnstile'; payload: string }) {
  return api.post('/api/auth/login').send({ email, password, ...(humanVerification ? { humanVerification } : {}) })
}

async function failFiveTimes(email: string) {
  for (let i = 0; i < 5; i++) {
    const res = await login(email, 'wrong-password').expect(401)
    expect(res.body.error).toEqual({ code: 'UNAUTHENTICATED', message: '邮箱或密码错误' })
  }
}

describe('login failure verification (SEC-02)', () => {
  beforeEach(() => {
    snapshot = {
      abuseProtectionMode: config.abuseProtectionMode,
      abuseHashKey: config.abuseHashKey,
      redisEnabled: config.redisEnabled,
      redisRequired: config.redisRequired,
      cacheKeyPrefix: config.cacheKeyPrefix,
      humanVerificationProvider: config.humanVerificationProvider,
    }
    config.abuseProtectionMode = 'enforce'
    config.abuseHashKey = Buffer.alloc(32, 9)
    config.redisEnabled = true
    config.redisRequired = true
    config.cacheKeyPrefix = 'login-failures-test'
    config.humanVerificationProvider = 'turnstile'
    __setRedisForTests(new ScriptedRedis())
    verifierCalls = []
    __setHumanVerifierForTesting({
      verify: async ({ payload, action }) => {
        verifierCalls.push({ payload, action })
        return payload === PROOF.payload ? { kind: 'verified' } : { kind: 'rejected' }
      },
    })
  })

  afterEach(() => {
    Object.assign(config, snapshot)
    __resetRedisForTests()
    __resetHumanVerifierForTesting()
  })

  it('requires a login proof after five failures instead of locking the owner out', async () => {
    const { user, password } = await createTestUser('verify-existing@test.local', 'Right#Pass-2026')
    await failFiveTimes(user.email)

    const required = await login(user.email, password).expect(400)
    expect(required.body.error.code).toBe('HUMAN_VERIFICATION_REQUIRED')
    const rejected = await login(user.email, password, { provider: 'turnstile', payload: 'forged' }).expect(403)
    expect(rejected.body.error.code).toBe('HUMAN_VERIFICATION_FAILED')

    await login(user.email, password, PROOF).expect(200)
    expect(verifierCalls.at(-1)).toEqual({ payload: PROOF.payload, action: 'login' })

    // A correct password clears the streak: the next login needs no proof.
    await login(user.email, password).expect(200)
  })

  it('keeps requiring a proof while verified attempts keep failing', async () => {
    const { user, password } = await createTestUser('verify-persist@test.local', 'Right#Pass-2026')
    await failFiveTimes(user.email)
    await login(user.email, 'wrong-password', PROOF).expect(401)
    const required = await login(user.email, password).expect(400)
    expect(required.body.error.code).toBe('HUMAN_VERIFICATION_REQUIRED')
  })

  it('treats an unknown email exactly like an existing one', async () => {
    await createTestUser('verify-known@test.local', 'Right#Pass-2026')
    const sequences = []
    for (const email of ['verify-known@test.local', 'verify-unknown@test.local']) {
      const sequence = []
      for (let i = 0; i < 6; i++) {
        const res = await login(email, 'wrong-password')
        sequence.push({ status: res.status, error: res.body.error })
      }
      sequence.push({ status: (await login(email, 'wrong-password', PROOF)).status })
      sequences.push(sequence)
    }
    expect(sequences[1]).toEqual(sequences[0])
    expect(sequences[0][5].status).toBe(400)
    expect(sequences[0][6].status).toBe(401)
  })

  it('does not affect a user who succeeds within a few attempts', async () => {
    const { user, password } = await createTestUser('verify-normal@test.local', 'Right#Pass-2026')
    for (let round = 0; round < 3; round++) {
      await login(user.email, 'wrong-password').expect(401)
      await login(user.email, 'wrong-password').expect(401)
      await login(user.email, password).expect(200)
    }
    expect(verifierCalls).toEqual([])
  })

  it('counts each email separately', async () => {
    const { user, password } = await createTestUser('verify-other@test.local', 'Right#Pass-2026')
    await failFiveTimes('verify-target@test.local')
    await login('verify-target@test.local', 'wrong-password').expect(400)
    await login(user.email, password).expect(200)
  })
})
