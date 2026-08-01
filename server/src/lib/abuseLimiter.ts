import { createHmac } from 'node:crypto'
import { config } from '../config/index.js'
import { runRedisCommandWithTimeout } from './redis.js'

/**
 * One Redis round trip owns the entire fixed-window state transition. Splitting
 * INCR and EXPIRE would leave a permanently-counted key if the process died
 * between commands, so no alternative implementation is permitted here.
 */
export const ABUSE_LIMITER_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`

export const ABUSE_LIMITER_IDENTIFIER_DIMENSIONS = ['ip', 'email', 'user', 'inviter'] as const
export type AbuseLimiterIdentifierDimension = typeof ABUSE_LIMITER_IDENTIFIER_DIMENSIONS[number]

export type AbuseLimiterBucket = {
  /** A fixed, code-owned flow name; it is never derived from a request. */
  flow: string
  dimension: AbuseLimiterIdentifierDimension
  limit: number
  windowMs: number
  /** A semantic fixed-window suffix, e.g. Shanghai `YYYY-MM-DD`. */
  windowKey?: string
}

export type AbuseLimiterResult = {
  allowed: boolean
  /** Zero when allowed; a rounded-up, safe-to-display delay when denied. */
  retryAfterSeconds: number
}

export interface AbuseLimiter {
  consume(bucket: AbuseLimiterBucket, subject: string | number): Promise<AbuseLimiterResult>
}

export type AbuseLuaExecutor = (
  script: string,
  keys: readonly string[],
  args: readonly string[],
) => Promise<unknown>

export type AbuseLimiterOptions = {
  cacheKeyPrefix?: string
  hashKey?: Buffer
  executeLua?: AbuseLuaExecutor
}

/**
 * Deliberately carries no Redis/provider error as a cause: callers map this
 * marker to the generic 503 contract and must not leak client details.
 */
export class AbuseProtectionUnavailableError extends Error {
  constructor() {
    super('abuse protection unavailable')
    this.name = 'AbuseProtectionUnavailableError'
  }
}

const SAFE_KEY_COMPONENT = /^[a-z][a-z0-9_-]{0,63}$/
const SAFE_WINDOW_COMPONENT = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_EMAIL_LENGTH = 320
const MAX_IP_LENGTH = 128

function unavailable(): never {
  throw new AbuseProtectionUnavailableError()
}

function assertBucket(bucket: AbuseLimiterBucket) {
  if (
    !SAFE_KEY_COMPONENT.test(bucket.flow)
    || !ABUSE_LIMITER_IDENTIFIER_DIMENSIONS.includes(bucket.dimension)
    || !Number.isSafeInteger(bucket.limit)
    || bucket.limit < 1
    || !Number.isSafeInteger(bucket.windowMs)
    || bucket.windowMs < 1
    || (bucket.windowKey !== undefined && !SAFE_WINDOW_COMPONENT.test(bucket.windowKey))
  ) {
    unavailable()
  }
}

function normalizeSubject(dimension: AbuseLimiterIdentifierDimension, subject: string | number): string {
  if (dimension === 'user' || dimension === 'inviter') {
    if (typeof subject !== 'number' || !Number.isSafeInteger(subject) || subject < 1) unavailable()
    return String(subject)
  }

  if (typeof subject !== 'string') unavailable()
  const normalized = dimension === 'email' ? subject.trim().toLowerCase() : subject.trim()
  const maxLength = dimension === 'email' ? MAX_EMAIL_LENGTH : MAX_IP_LENGTH
  if (!normalized || normalized.length > maxLength) unavailable()
  return normalized
}

function getHashKey(value: Buffer | undefined): Buffer {
  if (!value || !Buffer.isBuffer(value) || value.length !== 32) unavailable()
  return value
}

function hashIdentifier(value: string, hashKey: Buffer) {
  return createHmac('sha256', hashKey)
    .update(`v1\0${value}`, 'utf8')
    .digest('hex')
}

/**
 * Returns a versioned, non-reversible key. Only numeric account identifiers
 * are placed directly in the key; email and IP material always uses the
 * independent ABUSE_HASH_KEY HMAC namespace.
 */
export function buildAbuseLimiterKey(
  bucket: AbuseLimiterBucket,
  subject: string | number,
  options: Pick<AbuseLimiterOptions, 'cacheKeyPrefix' | 'hashKey'> = {},
) {
  assertBucket(bucket)

  const cacheKeyPrefix = (options.cacheKeyPrefix ?? config.cacheKeyPrefix).trim()
  if (!cacheKeyPrefix) unavailable()

  const normalizedSubject = normalizeSubject(bucket.dimension, subject)
  const keySubject = bucket.dimension === 'ip' || bucket.dimension === 'email'
    ? hashIdentifier(normalizedSubject, getHashKey(options.hashKey ?? config.abuseHashKey))
    : normalizedSubject
  const window = bucket.windowKey ?? String(bucket.windowMs)

  return `${cacheKeyPrefix}:abuse:v1:${bucket.flow}:${bucket.dimension}:${keySubject}:${window}`
}

function parseLuaResult(value: unknown): { count: number; ttlMs: number } {
  if (!Array.isArray(value) || value.length !== 2) unavailable()

  const count = Number(value[0])
  const ttlMs = Number(value[1])
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 0) unavailable()

  return { count, ttlMs }
}

const executeLuaWithRedis: AbuseLuaExecutor = async (script, keys, args) => {
  return runRedisCommandWithTimeout('abuse_limiter_eval', async client => {
    if (!client.eval) throw new Error('redis eval unavailable')
    return client.eval(script, keys.length, ...keys, ...args)
  })
}

/**
 * Factory form keeps tests entirely local and lets the auth integrator use a
 * narrow limiter contract. The default executor always goes through Redis;
 * there is intentionally no process-memory or database fallback.
 */
export function createAbuseLimiter(options: AbuseLimiterOptions = {}): AbuseLimiter {
  const executeLua = options.executeLua ?? executeLuaWithRedis

  return {
    async consume(bucket, subject) {
      try {
        const key = buildAbuseLimiterKey(bucket, subject, options)
        const raw = await executeLua(ABUSE_LIMITER_LUA, [key], [String(bucket.windowMs)])
        const { count, ttlMs } = parseLuaResult(raw)

        if (count <= bucket.limit) {
          return { allowed: true, retryAfterSeconds: 0 }
        }

        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
        }
      } catch (err) {
        if (err instanceof AbuseProtectionUnavailableError) throw err
        unavailable()
      }
    },
  }
}

/** Production singleton. Route integration must use this only in enforce mode. */
export const abuseLimiter = createAbuseLimiter()
