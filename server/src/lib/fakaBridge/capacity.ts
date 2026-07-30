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
 * Process-local TTL cache: product list/detail refresh must not hammer Xboard
 * on every browser F5. Independent of Redis product-list cache.
 * Success: 45s. Failure/unavailable: 15s (fail open but avoid tight loops).
 * Also indexes by planId so multi-period SKUs of the same plan share one probe.
 */
const CAPACITY_TTL_OK_MS = 45_000
const CAPACITY_TTL_FAIL_MS = 15_000
const capacityCache = new Map<string, { expiresAt: number; value: FakaCapacitySnapshot }>()
/** planId → sku key that holds the latest xboard snapshot */
const planToSkuKey = new Map<number, string>()
const capacityInflight = new Map<string, Promise<FakaCapacitySnapshot>>()

export function __clearFakaCapacityCacheForTests(): void {
  capacityCache.clear()
  planToSkuKey.clear()
  capacityInflight.clear()
}

/** Drop cached snapshot after admin writes capacity_limit to Xboard. */
export function invalidateFakaCapacityCache(sku?: string): void {
  if (!sku) {
    capacityCache.clear()
    planToSkuKey.clear()
    return
  }
  const key = sku.trim().toLowerCase()
  const prev = capacityCache.get(key)
  capacityCache.delete(key)
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
  for (const [k, v] of capacityCache) {
    if (v.value.source !== 'xboard') capacityCache.delete(k)
  }
}

function cloneForSku(snap: FakaCapacitySnapshot, sku: string): FakaCapacitySnapshot {
  return { ...snap, sku }
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
  if (!isFakaBridgeConfigured()) {
    return {
      sku: normalized,
      planId: null,
      capacityLimit: null,
      activeUsers: null,
      remaining: null,
      sellable: false,
      source: 'unavailable',
      reason: '平台未配置 FakaBridge',
    }
  }

  const now = Date.now()
  const hit = capacityCache.get(normalized)
  if (hit && hit.expiresAt > now) {
    return cloneForSku(hit.value, normalized)
  }

  // Reuse any live plan-level hit (other period SKU already probed this plan).
  for (const [, entry] of capacityCache) {
    if (entry.expiresAt <= now) continue
    if (entry.value.source !== 'xboard' || entry.value.planId == null) continue
    // Infer plan from alias plan-{id}-* without HTTP
    const m = normalized.match(/^plan-(\d+)-/)
    if (m && Number(m[1]) === entry.value.planId) {
      const adapted = cloneForSku(entry.value, normalized)
      capacityCache.set(normalized, { expiresAt: entry.expiresAt, value: adapted })
      return adapted
    }
    // Named SKUs: if we already have this plan via planToSkuKey, copy
    const knownSku = planToSkuKey.get(entry.value.planId)
    if (knownSku && knownSku !== normalized) {
      // Only reuse when plan mapping is known from prior xboard response for sibling —
      // we cannot map named SKU → plan without either cache of this sku or a probe.
      // Sibling reuse happens after first successful probe stores planId for this sku
      // in a second pass below; for named SKUs of same product, first probe fills planToSkuKey
      // and subsequent named SKUs still need one probe unless we have SKU→plan map.
    }
  }

  // Plan-key secondary: if any cached plan snapshot exists and this SKU's prior
  // entry had a planId (stale but we lost sku entry), try plan map.
  for (const [planId, skuKey] of planToSkuKey) {
    const entry = capacityCache.get(skuKey)
    if (!entry || entry.expiresAt <= now || entry.value.source !== 'xboard') continue
    // Only reuse if normalized SKU is known sibling: same planId in a previous
    // cache row for this exact SKU is gone; without static map we probe.
    void planId
  }

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
        capacityCache.set(normalized, { expiresAt: siblingHit.expiresAt, value: adapted })
        return adapted
      }
    }
  }

  const work = (async () => {
    try {
      const value = await fetchFakaCapacityUncached(normalized)
      const ttl =
        value.source === 'xboard' ? CAPACITY_TTL_OK_MS : CAPACITY_TTL_FAIL_MS
      const expiresAt = Date.now() + ttl
      capacityCache.set(normalized, { expiresAt, value })
      if (value.source === 'xboard' && value.planId != null) {
        planToSkuKey.set(value.planId, normalized)
        // Seed plan-* alias keys for free sibling hits
        const planKey = `plan:${value.planId}`
        capacityCache.set(planKey, { expiresAt, value })
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

/**
 * After any successful capacity for a plan, subsequent SKUs of that plan can
 * call this via loadFakaCapacityBySku grouping — public API still per-sku.
 * Expose helper for list loader to share plan snapshots.
 */
export function rememberFakaCapacityPlanSnapshot(snap: FakaCapacitySnapshot): void {
  if (snap.source !== 'xboard' || snap.planId == null) return
  const expiresAt = Date.now() + CAPACITY_TTL_OK_MS
  planToSkuKey.set(snap.planId, snap.sku)
  capacityCache.set(snap.sku, { expiresAt, value: snap })
  capacityCache.set(`plan:${snap.planId}`, { expiresAt, value: snap })
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
