import { Buffer } from 'node:buffer'
import { config } from '../config/index.js'
import { addBreadcrumb } from './errorReporter.js'
import { HttpError, type ErrorCode } from './httpError.js'
import { logger } from './logger.js'
import {
  cacheErrorsTotal,
  cacheFallbackDbTotal,
  cacheFillDuration,
  cacheHitsTotal,
  cacheInflightRequests,
  cacheInvalidationFailedTotal,
  cacheInvalidationsTotal,
  cacheMissesTotal,
  cacheNegativeHitsTotal,
  cacheValueBytes,
} from './metrics.js'
import { getRedis, runRedisCommandWithTimeout } from './redis.js'

export type CacheName = 'product-list' | 'product-detail' | 'product-reviews' | 'category-registry'

export type CacheNegativeError = {
  status: number
  code?: string
  message: string
}

export type CacheEnvelope<T> = {
  schemaVersion: 1
  cachedAt: number
} & (
  | { negative?: false; data: T }
  | { negative: true; data?: T; error?: CacheNegativeError }
)

export type CacheScope =
  | { name: 'product-list' }
  | { name: 'product-detail'; productId: number }
  | { name: 'product-reviews'; productId: number }
  | { name: 'category-registry' }

type WrapCacheOptions<T> = {
  negativeTtlSec?: number
  maxBytes?: number
  cachePredicate?: (value: T) => boolean
  negativeErrorPredicate?: (err: unknown) => boolean
}

const inflight = new Map<string, Promise<unknown>>()
const inflightCounts = new Map<CacheName, number>()
let lastProductListBumpAt = 0

function isCacheEnabled(name: CacheName) {
  if (!config.redisEnabled) return false
  if (name === 'product-list') return config.cacheProductList
  if (name === 'product-detail') return config.cacheProductDetail
  if (name === 'category-registry') return config.cacheCategoryRegistry
  return config.cacheProductReviews
}

function cacheKeyPrefix() {
  return `${config.cacheKeyPrefix}:v1`
}

export function makeCacheKey(...parts: Array<string | number>) {
  return [cacheKeyPrefix(), ...parts].join(':')
}

function versionKey(scope: CacheScope) {
  if (scope.name === 'product-list') return makeCacheKey('ver', 'product-list')
  if (scope.name === 'category-registry') return makeCacheKey('ver', 'category-registry')
  return makeCacheKey('ver', scope.name, scope.productId)
}

function scopeLabel(scope: CacheScope) {
  if (scope.name === 'product-list') return 'product-list'
  if (scope.name === 'category-registry') return 'category-registry'
  return `${scope.name}:${scope.productId}`
}

function ttlWithJitter(ttlSec: number) {
  if (ttlSec <= 1) return ttlSec
  const jitter = Math.max(1, Math.floor(ttlSec * 0.2))
  return Math.max(1, ttlSec + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter)
}

function recordCacheError(name: CacheName, op: string, err: unknown) {
  cacheErrorsTotal.inc({ name, op })
  addBreadcrumb({
    category: 'cache',
    level: 'warning',
    message: `cache ${op} failed`,
    data: {
      name,
      error: err instanceof Error ? err.message : String(err),
    },
  })
}

function incInflight(name: CacheName) {
  const next = (inflightCounts.get(name) ?? 0) + 1
  inflightCounts.set(name, next)
  cacheInflightRequests.set({ name }, next)
}

function decInflight(name: CacheName) {
  const next = Math.max(0, (inflightCounts.get(name) ?? 1) - 1)
  inflightCounts.set(name, next)
  cacheInflightRequests.set({ name }, next)
}

function encodeEnvelope<T>(envelope: CacheEnvelope<T>) {
  const serialized = JSON.stringify(envelope)
  return {
    serialized,
    bytes: Buffer.byteLength(serialized, 'utf8'),
  }
}

async function writeEnvelope<T>(
  name: CacheName,
  key: string,
  ttlSec: number,
  envelope: CacheEnvelope<T>,
  maxBytes: number
) {
  const { serialized, bytes } = encodeEnvelope(envelope)
  cacheValueBytes.observe({ name }, bytes)

  if (bytes > maxBytes) {
    cacheFallbackDbTotal.inc({ name, reason: 'value_too_large' })
    logger.warn({ name, key, bytes, maxBytes }, 'cache value too large, skip write')
    return
  }

  await runRedisCommandWithTimeout('set', client => client.set(key, serialized, 'EX', ttlWithJitter(ttlSec)))
}

function parseEnvelope<T>(raw: string): CacheEnvelope<T> | null {
  const parsed = JSON.parse(raw) as Partial<CacheEnvelope<T>>
  if (parsed.schemaVersion !== 1 || typeof parsed.cachedAt !== 'number') return null
  return parsed as CacheEnvelope<T>
}

function throwCachedError(error: CacheNegativeError): never {
  const code = (error.code ?? (error.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST')) as ErrorCode
  throw new HttpError(error.status, code, error.message)
}

async function fillCache<T>(
  name: CacheName,
  key: string,
  ttlSec: number,
  fallback: () => Promise<T>,
  options: WrapCacheOptions<T>,
  allowWrite: boolean
) {
  const end = cacheFillDuration.startTimer({ name })

  try {
    const value = await fallback()
    if (options.cachePredicate && !options.cachePredicate(value)) return value

    if (allowWrite) {
      try {
        await writeEnvelope(
          name,
          key,
          ttlSec,
          { schemaVersion: 1, cachedAt: Date.now(), data: value },
          options.maxBytes ?? config.cacheMaxValueBytes
        )
      } catch (err) {
        recordCacheError(name, 'set', err)
        logger.warn({ err, name, key }, 'cache set failed')
      }
    }

    return value
  } catch (err) {
    if (allowWrite && options.negativeErrorPredicate?.(err)) {
      const httpError = err as HttpError
      try {
        await writeEnvelope(
          name,
          key,
          options.negativeTtlSec ?? ttlSec,
          {
            schemaVersion: 1,
            cachedAt: Date.now(),
            negative: true,
            error: {
              status: httpError.status,
              code: httpError.code,
              message: httpError.message,
            },
          },
          options.maxBytes ?? config.cacheMaxValueBytes
        )
      } catch (writeErr) {
        recordCacheError(name, 'set_negative', writeErr)
        logger.warn({ err: writeErr, name, key }, 'negative cache set failed')
      }
    }
    throw err
  } finally {
    end()
  }
}

export async function wrapCache<T>(
  name: CacheName,
  key: string,
  ttlSec: number,
  fallback: () => Promise<T>,
  options: WrapCacheOptions<T> = {}
): Promise<T> {
  if (!isCacheEnabled(name)) {
    cacheFallbackDbTotal.inc({ name, reason: 'disabled' })
    return fallback()
  }

  let allowWrite = true

  try {
    const raw = await runRedisCommandWithTimeout('get', client => client.get(key))
    if (raw) {
      const envelope = parseEnvelope<T>(raw)
      if (!envelope) {
        cacheErrorsTotal.inc({ name, op: 'parse' })
        await runRedisCommandWithTimeout('del', client => client.del(key))
      } else if (envelope.negative) {
        cacheHitsTotal.inc({ name })
        cacheNegativeHitsTotal.inc({ name })
        if (envelope.error) throwCachedError(envelope.error)
        return envelope.data as T
      } else {
        cacheHitsTotal.inc({ name })
        return envelope.data
      }
    }
    cacheMissesTotal.inc({ name })
  } catch (err) {
    if (err instanceof HttpError) throw err
    allowWrite = false
    recordCacheError(name, 'get', err)
    cacheFallbackDbTotal.inc({ name, reason: 'redis_error' })
    logger.warn({ err, name, key }, 'cache get failed, falling back to DB')
  }

  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const promise = fillCache(name, key, ttlSec, fallback, options, allowWrite)
  inflight.set(key, promise)
  incInflight(name)

  try {
    return await promise
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key)
    decInflight(name)
  }
}

export async function getCacheVersion(scope: CacheScope): Promise<number | null> {
  if (!config.redisEnabled) return 0

  try {
    const value = await runRedisCommandWithTimeout('get', client => client.get(versionKey(scope)))
    const parsed = value ? Number(value) : 0
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  } catch (err) {
    cacheErrorsTotal.inc({ name: scope.name, op: 'version_get' })
    addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'cache version get failed',
      data: { scope: scopeLabel(scope), error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}

export async function bumpCacheVersion(scope: CacheScope): Promise<void> {
  if (!config.redisEnabled) return

  cacheInvalidationsTotal.inc({ name: scope.name, scope: scopeLabel(scope) })

  try {
    await runRedisCommandWithTimeout('incr', client => client.incr(versionKey(scope)))
  } catch (err) {
    cacheInvalidationFailedTotal.inc({ scope: scopeLabel(scope) })
    addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'cache invalidation failed',
      data: { scope: scopeLabel(scope), error: err instanceof Error ? err.message : String(err) },
    })
    logger.warn({ err, scope: scopeLabel(scope) }, 'cache version bump failed')
  }
}

export async function bumpProductListVersionCoalesced() {
  const coalesceMs = config.cacheProductListVersionCoalesceMs
  if (coalesceMs <= 0) {
    await bumpCacheVersion({ name: 'product-list' })
    return
  }

  const current = Date.now()
  if (current - lastProductListBumpAt < coalesceMs) return

  try {
    const coalesceKey = makeCacheKey('coalesce', 'product-list')
    const result = await runRedisCommandWithTimeout('set_nx_px', client =>
      client.set(coalesceKey, '1', 'NX', 'PX', coalesceMs)
    )
    lastProductListBumpAt = current
    if (result === 'OK') await bumpCacheVersion({ name: 'product-list' })
  } catch (err) {
    lastProductListBumpAt = current
    cacheErrorsTotal.inc({ name: 'product-list', op: 'coalesce' })
    addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'product list coalesce failed',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    await bumpCacheVersion({ name: 'product-list' })
  }
}

export function clearCacheProcessState() {
  inflight.clear()
  inflightCounts.clear()
  lastProductListBumpAt = 0
  for (const name of ['product-list', 'product-detail', 'product-reviews', 'category-registry'] as const) {
    cacheInflightRequests.set({ name }, 0)
  }
}

export async function __resetCacheForTests() {
  clearCacheProcessState()

  const client = getRedis()
  if (!client?.keys) return

  const keys = await client.keys(`${cacheKeyPrefix()}:*`)
  if (keys.length > 0) await client.del(...keys)
}
