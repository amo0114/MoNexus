import { config } from '../../config/index.js'
import { callFakaPlanCapacity, isFakaBridgeConfigured } from './client.js'
import { logger } from '../logger.js'
import { fakaCapacityProbeTotal } from '../metrics.js'

export type FakaCapacitySnapshot = {
  sku: string
  planId: number | null
  /** null = unlimited on Xboard */
  capacityLimit: number | null
  activeUsers: number | null
  /** null = unlimited */
  remaining: number | null
  sellable: boolean
  source: 'xboard' | 'unavailable'
  reason?: string
}

/**
 * Process-local cache for Xboard capacity.  Authoritative consumers (checkout
 * confirmation/admin mutations) await a refresh; public reads only consume a
 * fresh or bounded-stale snapshot and schedule their refresh in the background.
 * This keeps Xboard availability off the storefront request critical path.
 */
const CAPACITY_TTL_OK_MS = 45_000
const CAPACITY_TTL_FAIL_MS = 15_000
const CAPACITY_STALE_OK_MS = 5 * 60_000

type CapacityCacheEntry = {
  /** Freshness boundary for authoritative callers. */
  expiresAt: number
  /** Bounded SWR window for storefront/read-only callers. */
  staleUntil: number
  value: FakaCapacitySnapshot
}

type CapacityFailureEntry = {
  expiresAt: number
  value: FakaCapacitySnapshot
}

/** Successful Xboard snapshots, retained through their bounded SWR window. */
const capacityCache = new Map<string, CapacityCacheEntry>()
/**
 * Short negative TTL kept separately from the last successful snapshot.  A
 * transient Xboard failure must not overwrite stale-but-useful public data.
 */
const capacityFailures = new Map<string, CapacityFailureEntry>()
/** planId → sku key that holds the latest xboard snapshot */
const planToSkuKey = new Map<number, string>()
const capacityInflight = new Map<string, Promise<FakaCapacitySnapshot>>()

/** Test seam: avoids a real Xboard HTTP server in cache/SWR regressions. */
let capacityProbeForTests: ((sku: string) => Promise<FakaCapacitySnapshot>) | undefined

export function __clearFakaCapacityCacheForTests(): void {
  capacityCache.clear()
  capacityFailures.clear()
  planToSkuKey.clear()
  capacityInflight.clear()
  capacityProbeForTests = undefined
}

export function __setFakaCapacityProbeForTests(
  probe?: (sku: string) => Promise<FakaCapacitySnapshot>
): void {
  capacityProbeForTests = probe
}

/** Drop cached snapshot after admin writes capacity_limit to Xboard. */
export function invalidateFakaCapacityCache(sku?: string): void {
  if (!sku) {
    capacityCache.clear()
    capacityFailures.clear()
    planToSkuKey.clear()
    return
  }
  const key = sku.trim().toLowerCase()
  const prev = capacityCache.get(key)
  capacityCache.delete(key)
  capacityFailures.delete(key)
  if (prev?.value.planId != null) {
    planToSkuKey.delete(prev.value.planId)
    // Drop all SKU entries that pointed at same plan
    for (const [k, v] of capacityCache) {
      if (v.value.planId === prev.value.planId) capacityCache.delete(k)
    }
  }
}

/** Drop only negative cache entries (so a transient failure can retry immediately). */
export function invalidateFakaCapacityFailures(): void {
  capacityFailures.clear()
}

function cloneForSku(snap: FakaCapacitySnapshot, sku: string): FakaCapacitySnapshot {
  return { ...snap, sku }
}

function unavailableCapacity(
  sku: string,
  reason: string,
  sellable = true
): FakaCapacitySnapshot {
  return {
    sku,
    planId: null,
    capacityLimit: null,
    activeUsers: null,
    remaining: null,
    sellable,
    source: 'unavailable',
    reason,
  }
}

function isCapacityProbeConfigured(): boolean {
  return capacityProbeForTests != null || isFakaBridgeConfigured()
}

function cacheSuccessfulCapacity(key: string, value: FakaCapacitySnapshot): CapacityCacheEntry {
  const expiresAt = Date.now() + CAPACITY_TTL_OK_MS
  const entry: CapacityCacheEntry = {
    expiresAt,
    // A successful snapshot may be served while its replacement is fetched,
    // but only for a bounded time.
    staleUntil: expiresAt + CAPACITY_STALE_OK_MS,
    value,
  }
  capacityCache.set(key, entry)
  return entry
}

function cacheCapacityFailure(key: string, value: FakaCapacitySnapshot): void {
  capacityFailures.set(key, {
    expiresAt: Date.now() + CAPACITY_TTL_FAIL_MS,
    value,
  })
}

function getCachedCapacityFailure(normalized: string): FakaCapacitySnapshot | null {
  const entry = capacityFailures.get(normalized)
  if (!entry) return null
  if (entry.expiresAt > Date.now()) return cloneForSku(entry.value, normalized)
  capacityFailures.delete(normalized)
  return null
}

function copyCachedCapacity(key: string, value: FakaCapacitySnapshot, source: CapacityCacheEntry): void {
  capacityCache.set(key, {
    expiresAt: source.expiresAt,
    staleUntil: source.staleUntil,
    value,
  })
}

function getCachedFakaCapacityForSkuInternal(
  normalized: string,
  allowStale: boolean
): FakaCapacitySnapshot | null {
  const now = Date.now()
  const usable = (entry: CapacityCacheEntry | undefined) =>
    entry != null && (allowStale ? entry.staleUntil > now : entry.expiresAt > now)

  const direct = capacityCache.get(normalized)
  if (usable(direct)) return cloneForSku(direct!.value, normalized)

  // Plan aliases can share a single Xboard plan-level snapshot without a
  // second probe.  Named SKUs intentionally do not guess plan membership.
  const planAlias = normalized.match(/^plan-(\d+)-/)
  if (!planAlias) return null
  const planEntry = capacityCache.get(`plan:${Number(planAlias[1])}`)
  if (usable(planEntry) && planEntry!.value.source === 'xboard') {
    return cloneForSku(planEntry!.value, normalized)
  }
  return null
}

function refreshFakaCapacityInBackground(normalized: string): void {
  void fetchFakaCapacityForSku(normalized).catch(err => {
    // Production fetches normally fold transport errors into an unavailable
    // snapshot.  Keep this catch for test probes/unexpected failures so an
    // SWR refresh can never become an unhandled rejection.
    logger.warn({ err, sku: normalized }, 'Faka capacity background refresh failed')
  })
}

/**
 * Read path for storefront, checkout preview and other non-authoritative UI.
 * It never waits for Xboard: use a fresh snapshot, then a bounded stale one,
 * otherwise fail open as unavailable and start one deduplicated background
 * refresh.  The order-create path deliberately uses fetchFakaCapacityForSku
 * instead, so its capacity preflight remains authoritative.
 */
export function getFakaCapacityForPublicRead(sku: string): FakaCapacitySnapshot {
  const normalized = sku.trim().toLowerCase()
  if (!isCapacityProbeConfigured()) {
    return unavailableCapacity(normalized, '平台未配置 FakaBridge', false)
  }

  const fresh = getCachedFakaCapacityForSkuInternal(normalized, false)
  if (fresh) return fresh

  const stale = getCachedFakaCapacityForSkuInternal(normalized, true)
  if (stale) {
    refreshFakaCapacityInBackground(normalized)
    return stale
  }

  const failure = getCachedCapacityFailure(normalized)
  if (failure) return failure

  refreshFakaCapacityInBackground(normalized)
  return unavailableCapacity(normalized, '暂时无法确认 Xboard 套餐名额')
}

/** Warm unique active SKU snapshots without making user requests wait. */
export async function prewarmFakaCapacityForSkus(skus: Iterable<string>): Promise<number> {
  if (!isCapacityProbeConfigured()) return 0

  const normalizedUnique = [
    ...new Set(
      [...skus]
        .map(sku => sku.trim().toLowerCase())
        .filter(Boolean)
    ),
  ]
  // Xboard capacity is plan-level.  For the canonical plan-{id}-* aliases,
  // one probe warms every period SKU; named SKUs cannot be safely grouped.
  const seenPlanIds = new Set<number>()
  const unique = normalizedUnique.filter(sku => {
    const planAlias = sku.match(/^plan-(\d+)-/)
    if (!planAlias) return true
    const planId = Number(planAlias[1])
    if (seenPlanIds.has(planId)) return false
    seenPlanIds.add(planId)
    return true
  })
  const concurrency = Math.min(4, unique.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < unique.length) {
      const sku = unique[cursor++]
      try {
        await fetchFakaCapacityForSku(sku)
      } catch (err) {
        logger.warn({ err, sku }, 'Faka capacity prewarm failed')
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return unique.length
}

/**
 * Pre-check Xboard plan capacity for a Faka SKU.
 * - Successful remaining===0 → not sellable (block checkout).
 * - Network / config failure → source=unavailable (do not hard-block sales;
 *   order path still fails closed on Xboard 售罄 + refund).
 * - Results are memoized briefly so homepage refresh does not re-hit Xboard every time.
 * - Same planId snapshots are reused across period SKUs (no 8× HTTP for multi-offer cards).
 */
export async function fetchFakaCapacityForSku(sku: string): Promise<FakaCapacitySnapshot> {
  const normalized = sku.trim().toLowerCase()
  if (!isCapacityProbeConfigured()) {
    return unavailableCapacity(normalized, '平台未配置 FakaBridge', false)
  }

  const fresh = getCachedFakaCapacityForSkuInternal(normalized, false)
  if (fresh) return fresh

  const cachedFailure = getCachedCapacityFailure(normalized)
  if (cachedFailure) return cachedFailure

  const now = Date.now()

  const pending = capacityInflight.get(normalized)
  if (pending) return pending.then(v => cloneForSku(v, normalized))

  // If another inflight for same plan via plan-* alias
  const planAlias = normalized.match(/^plan-(\d+)-/)
  if (planAlias) {
    const planId = Number(planAlias[1])
    const siblingKey = planToSkuKey.get(planId)
    if (siblingKey) {
      const siblingPending = capacityInflight.get(siblingKey)
      if (siblingPending) {
        return siblingPending.then(v => {
          const adapted = cloneForSku(v, normalized)
          return adapted
        })
      }
      const siblingHit = capacityCache.get(siblingKey)
      if (siblingHit && siblingHit.expiresAt > now && siblingHit.value.source === 'xboard') {
        const adapted = cloneForSku(siblingHit.value, normalized)
        copyCachedCapacity(normalized, adapted, siblingHit)
        return adapted
      }
    }
  }

  const work = (async () => {
    try {
      const value = cloneForSku(
        capacityProbeForTests
          ? await capacityProbeForTests(normalized)
          : await fetchFakaCapacityUncached(normalized),
        normalized
      )
      if (value.source === 'xboard' && value.planId != null) {
        const entry = cacheSuccessfulCapacity(normalized, value)
        capacityFailures.delete(normalized)
        planToSkuKey.set(value.planId, normalized)
        // Seed plan-* alias keys for free sibling hits
        const planKey = `plan:${value.planId}`
        copyCachedCapacity(planKey, value, entry)
      } else if (value.source === 'xboard') {
        cacheSuccessfulCapacity(normalized, value)
        capacityFailures.delete(normalized)
      } else {
        cacheCapacityFailure(normalized, value)
      }
      fakaCapacityProbeTotal.inc({ source: value.source })
      return value
    } finally {
      capacityInflight.delete(normalized)
    }
  })()

  capacityInflight.set(normalized, work)
  return work
}

export function getCachedFakaCapacityByPlanId(planId: number): FakaCapacitySnapshot | null {
  const now = Date.now()
  const entry = capacityCache.get(`plan:${planId}`)
  if (entry && entry.expiresAt > now && entry.value.source === 'xboard') {
    return entry.value
  }
  const skuKey = planToSkuKey.get(planId)
  if (!skuKey) return null
  const hit = capacityCache.get(skuKey)
  if (hit && hit.expiresAt > now && hit.value.source === 'xboard') return hit.value
  return null
}

async function fetchFakaCapacityUncached(normalized: string): Promise<FakaCapacitySnapshot> {
  // plan-* alias: if plan-level cache warm, skip HTTP
  const planAlias = normalized.match(/^plan-(\d+)-/)
  if (planAlias) {
    const cached = getCachedFakaCapacityByPlanId(Number(planAlias[1]))
    if (cached) return cloneForSku(cached, normalized)
  }

  try {
    const res = await callFakaPlanCapacity(normalized, {
      timeoutMs: Math.min(config.fakaBridge.timeoutMs, 8_000),
    })
    if (!res.ok || !res.body || res.body.success !== true) {
      const errMsg =
        res.body && typeof res.body === 'object' && 'error' in res.body
          ? String((res.body as { error?: string }).error ?? '')
          : res.rawText
      logger.warn(
        { sku: normalized, code: res.code, http: res.httpStatus, errMsg },
        'Faka capacity precheck failed'
      )
      return {
        sku: normalized,
        planId: null,
        capacityLimit: null,
        activeUsers: null,
        remaining: null,
        sellable: true,
        source: 'unavailable',
        reason: '暂时无法确认 Xboard 套餐名额',
      }
    }

    const body = res.body
    const capacityLimit =
      body.capacity_limit === null || body.capacity_limit === undefined
        ? null
        : Number(body.capacity_limit)
    const activeUsers =
      body.active_users === null || body.active_users === undefined
        ? null
        : Number(body.active_users)
    const remaining =
      body.remaining === null || body.remaining === undefined
        ? null
        : Number(body.remaining)
    const sellable = body.sellable !== false && (remaining === null || remaining > 0)

    return {
      sku: normalized,
      planId: body.plan_id != null ? Number(body.plan_id) : null,
      capacityLimit: Number.isFinite(capacityLimit as number) ? capacityLimit : null,
      activeUsers: Number.isFinite(activeUsers as number) ? activeUsers : null,
      remaining: remaining === null || Number.isFinite(remaining) ? remaining : null,
      sellable,
      source: 'xboard',
      reason: sellable ? undefined : 'Xboard 套餐名额已满（订阅人数限制）',
    }
  } catch (err) {
    logger.warn({ err, sku: normalized }, 'Faka capacity precheck exception')
    return {
      sku: normalized,
      planId: null,
      capacityLimit: null,
      activeUsers: null,
      remaining: null,
      sellable: true,
      source: 'unavailable',
      reason: '暂时无法确认 Xboard 套餐名额',
    }
  }
}
