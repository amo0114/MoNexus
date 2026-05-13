import { config } from '../config/index.js'

type Entry = {
  status: string
  expiresAt: number
}

const defaultMaxEntries = 10_000
const cache = new Map<number, Entry>()

let maxEntries = defaultMaxEntries
let ttlSecOverride: number | undefined
let now = () => Date.now()

function ttlMs() {
  const ttlSec = ttlSecOverride ?? config.userStatusCacheTtlSec
  return ttlSec * 1000
}

function isEnabled() {
  return ttlMs() > 0
}

export function getCached(userId: number): string | undefined {
  if (!isEnabled()) return undefined

  const entry = cache.get(userId)
  if (!entry) return undefined

  if (entry.expiresAt <= now()) {
    cache.delete(userId)
    return undefined
  }

  cache.delete(userId)
  cache.set(userId, entry)
  return entry.status
}

export function setCached(userId: number, status: string) {
  if (!isEnabled()) return

  if (cache.has(userId)) {
    cache.delete(userId)
  } else if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }

  cache.set(userId, {
    status,
    expiresAt: now() + ttlMs(),
  })
}

export function invalidate(userId: number) {
  cache.delete(userId)
}

export function _clearAll() {
  cache.clear()
}

export function _setMaxEntriesForTesting(value: number) {
  maxEntries = value
}

export function _setNowForTesting(fn: () => number) {
  now = fn
}

export function _setTtlSecForTesting(value: number) {
  ttlSecOverride = value
}

export function _resetForTesting() {
  cache.clear()
  maxEntries = defaultMaxEntries
  ttlSecOverride = undefined
  now = () => Date.now()
}
