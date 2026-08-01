import Redis from 'ioredis'
import { config } from '../config/index.js'
import { logger } from './logger.js'
import { redisCircuitState, redisCommandDuration, redisStatus } from './metrics.js'

export type RedisHealthStatus = 'ok' | 'disabled' | 'degraded'

/**
 * Deliberately narrow Redis surface shared by the cache and security limiter.
 * `eval` is required because security limiters must be able to make one atomic
 * Redis transition. The abuse limiter still runtime-checks it defensively so
 * an untyped/incomplete injected client fails closed rather than falling back.
 */
export type RedisLike = {
  status?: string
  connect?: () => Promise<unknown>
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ...args: unknown[]) => Promise<unknown>
  del: (...keys: string[]) => Promise<number>
  incr: (key: string) => Promise<number>
  eval: (script: string, numberOfKeys: number, ...args: string[]) => Promise<unknown>
  ping: () => Promise<string>
  quit?: () => Promise<unknown>
  disconnect?: () => void
  keys?: (pattern: string) => Promise<string[]>
}

let redis: Redis | null = null
let redisForTests: RedisLike | null | undefined
let consecutiveErrors = 0
let circuitOpenUntil = 0

export function sanitizeRedisUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '[redacted]'
    if (parsed.username) parsed.username = '[redacted]'
    return parsed.toString()
  } catch {
    return '[invalid redis url]'
  }
}

function now() {
  return Date.now()
}

function setCircuitMetric(open: boolean) {
  redisCircuitState.set({ state: 'closed' }, open ? 0 : 1)
  redisCircuitState.set({ state: 'open' }, open ? 1 : 0)
}

function setRedisStatusMetric(status: RedisHealthStatus) {
  redisStatus.set({ status: 'disabled' }, status === 'disabled' ? 1 : 0)
  redisStatus.set({ status: 'ok' }, status === 'ok' ? 1 : 0)
  redisStatus.set({ status: 'degraded' }, status === 'degraded' ? 1 : 0)
}

function isCircuitOpen() {
  if (circuitOpenUntil <= now()) {
    if (circuitOpenUntil !== 0) {
      circuitOpenUntil = 0
      setCircuitMetric(false)
      logger.info('redis circuit closed')
    }
    return false
  }
  return true
}

function recordRedisSuccess() {
  consecutiveErrors = 0
  if (circuitOpenUntil !== 0) {
    circuitOpenUntil = 0
    logger.info('redis circuit closed')
  }
  setCircuitMetric(false)
  setRedisStatusMetric('ok')
}

function recordRedisFailure(op: string, err: unknown) {
  consecutiveErrors += 1
  setRedisStatusMetric('degraded')

  if (consecutiveErrors >= config.redisCircuitErrorThreshold) {
    circuitOpenUntil = now() + config.redisCircuitOpenMs
    setCircuitMetric(true)
    logger.warn({ err, op }, 'redis circuit opened')
  }
}

export function isRedisConfigured() {
  return config.redisEnabled
}

export function getRedis(): RedisLike | null {
  if (redisForTests !== undefined) return redisForTests

  if (!config.redisEnabled) {
    setRedisStatusMetric('disabled')
    return null
  }

  if (isCircuitOpen()) {
    setRedisStatusMetric('degraded')
    return null
  }

  if (!redis) {
    redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: config.redisConnectTimeoutMs,
      password: config.redisPassword,
      tls: config.redisTls ? {} : undefined,
      retryStrategy(times) {
        return Math.min(times * 50, 1000)
      },
    })

    redis.on('error', err => {
      recordRedisFailure('event:error', err)
      logger.warn({ err, redisUrl: sanitizeRedisUrl(config.redisUrl) }, 'redis client error')
    })
  }

  return redis as unknown as RedisLike
}

async function withTimeout<T>(op: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`redis ${op} timeout`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function ensureConnected(client: RedisLike) {
  if (!client.connect || !client.status || client.status === 'ready') return
  if (client.status === 'connect' || client.status === 'connecting') return
  await withTimeout('connect', client.connect(), config.redisConnectTimeoutMs)
}

export async function runRedisCommandWithTimeout<T>(
  op: string,
  command: (client: RedisLike) => Promise<T>
): Promise<T> {
  const client = getRedis()
  if (!client) throw new Error('redis unavailable')

  const end = redisCommandDuration.startTimer({ op })
  try {
    await ensureConnected(client)
    const result = await withTimeout(op, command(client), config.redisCommandTimeoutMs)
    recordRedisSuccess()
    return result
  } catch (err) {
    recordRedisFailure(op, err)
    throw err
  } finally {
    end()
  }
}

export async function pingRedis(): Promise<RedisHealthStatus> {
  if (!config.redisEnabled) {
    setRedisStatusMetric('disabled')
    return 'disabled'
  }

  try {
    const pong = await runRedisCommandWithTimeout('ping', client => client.ping())
    const status = pong === 'PONG' ? 'ok' : 'degraded'
    setRedisStatusMetric(status)
    return status
  } catch {
    setRedisStatusMetric('degraded')
    return 'degraded'
  }
}

export async function quitRedis() {
  const client = redis
  redis = null
  consecutiveErrors = 0
  circuitOpenUntil = 0
  setCircuitMetric(false)

  if (!client) return

  try {
    await withTimeout('quit', client.quit(), config.redisCommandTimeoutMs)
  } catch (err) {
    logger.warn({ err }, 'redis quit failed, disconnecting')
    client.disconnect()
  }
}

export function __setRedisForTests(client: RedisLike | null) {
  redisForTests = client
  consecutiveErrors = 0
  circuitOpenUntil = 0
  setCircuitMetric(false)
}

export function __resetRedisForTests() {
  redisForTests = undefined
  consecutiveErrors = 0
  circuitOpenUntil = 0
  setCircuitMetric(false)
}
