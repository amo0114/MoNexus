/**
 * SPEC-NOTIFY-RT-001 — typed invalidation bus + exact-ID dedupe (T-FE-002).
 *
 * Implements: 512-entry exact-ID LRU (never maxSeen, NRT-016), 300ms per-topic
 * coalescing with in-flight dirty rerun, the spec 7.3 event matrix, and live
 * Toast rules (live + visible + first exact ID; instant/unknown silent).
 */
export type InvalidationTopic = 'notifications' | 'buyer.orders' | 'merchant.orders' | 'merchant.stats' | 'all.visible'

export const INVALIDATION_TOPICS: readonly InvalidationTopic[] = [
  'notifications',
  'buyer.orders',
  'merchant.orders',
  'merchant.stats',
  'all.visible',
]

export const EXACT_ID_LRU_CAPACITY = 512
export const TOPIC_COALESCE_MS = 300

export interface RealtimeNotificationData {
  id: number
  eventType: string
  category: string
  title: string
  body: string
  level: string
  deeplink: string
  relatedOrderId: number | null
  createdAt: string
  deliveryMode?: string
  deliveryKind?: string
}

export interface LiveToastSpec {
  /** null = silent (no toast at all). */
  level: 'info' | 'success' | 'warning' | null
}

/** spec 7.3 event -> topics + toast matrix. Unknown events -> notifications only, silent. */
export const EVENT_INVALIDATION_MATRIX: Record<string, { topics: InvalidationTopic[]; toast: LiveToastSpec }> = {
  'order.created_merchant': { topics: ['notifications', 'merchant.orders', 'merchant.stats'], toast: { level: 'info' } },
  'order.processing_buyer': { topics: ['notifications', 'buyer.orders'], toast: { level: 'info' } },
  'order.delivered_buyer': {
    topics: ['notifications', 'buyer.orders'],
    toast: { level: 'success' }, // instant delivered is silenced by deliveryKind below
  },
  'order.refunded_buyer': { topics: ['notifications', 'buyer.orders'], toast: { level: 'info' } },
  'order.refunded_merchant': { topics: ['notifications', 'merchant.orders', 'merchant.stats'], toast: { level: 'info' } },
  'order.disputed_buyer': { topics: ['notifications', 'buyer.orders'], toast: { level: 'warning' } },
  'order.disputed_merchant': { topics: ['notifications', 'merchant.orders', 'merchant.stats'], toast: { level: 'warning' } },
  'order.dispute_resolved_buyer': { topics: ['notifications', 'buyer.orders'], toast: { level: 'info' } },
  'order.dispute_resolved_merchant': { topics: ['notifications', 'merchant.orders', 'merchant.stats'], toast: { level: 'info' } },
  'order.closed_buyer': { topics: ['notifications', 'buyer.orders'], toast: { level: 'info' } },
}

/** Unknown events only invalidate notifications and never toast (NRT-022). */
export function resolveInvalidation(n: RealtimeNotificationData): { topics: InvalidationTopic[]; toast: LiveToastSpec } {
  const known = EVENT_INVALIDATION_MATRIX[n.eventType]
  if (!known) return { topics: ['notifications'], toast: { level: null } }
  // instant delivered is silent (spec 7.3): buyer sees status change, no toast.
  if (n.eventType === 'order.delivered_buyer' && (n.deliveryKind === 'instant' || n.deliveryMode?.startsWith('instant_'))) {
    return { ...known, toast: { level: null } }
  }
  return known
}

/**
 * Bounded exact-ID LRU scoped to the current user. Only IDs still inside the
 * window are deduped; evicted IDs may legitimately fire a later live hint.
 */
export class ExactIdLru {
  private readonly map = new Map<number, true>()

  constructor(private readonly capacity = EXACT_ID_LRU_CAPACITY) {}

  /** Returns true when the id was already present (a duplicate). */
  has(id: number): boolean {
    return this.map.has(id)
  }

  /** Record an id as seen; evicts the least-recently-used when over capacity. */
  record(id: number): void {
    if (this.map.has(id)) {
      // Refresh recency.
      this.map.delete(id)
    }
    this.map.set(id, true)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as number | undefined
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

type Subscriber = () => void | Promise<void>

/**
 * 300ms per-topic coalescer with single in-flight reload + dirty rerun.
 */
export class InvalidationScheduler {
  private readonly subscribers = new Map<InvalidationTopic, Set<Subscriber>>()
  private readonly timers = new Map<InvalidationTopic, ReturnType<typeof setTimeout>>()
  private readonly inflight = new Set<InvalidationTopic>()
  private readonly dirty = new Set<InvalidationTopic>()
  private epoch = 0

  subscribe(topic: InvalidationTopic, cb: Subscriber): () => void {
    let set = this.subscribers.get(topic)
    if (!set) {
      set = new Set()
      this.subscribers.set(topic, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
    }
  }

  /** Coalesce an invalidation request for a topic. */
  invalidate(topic: InvalidationTopic): void {
    if (this.timers.has(topic)) return
    const timer = setTimeout(() => {
      this.timers.delete(topic)
      this.dispatch(topic)
    }, TOPIC_COALESCE_MS)
    this.timers.set(topic, timer)
  }

  /** Publish immediately without coalescing (used for ready / fallback / visible). */
  publishNow(topic: InvalidationTopic): void {
    this.dispatch(topic)
  }

  private dispatch(topic: InvalidationTopic): void {
    if (this.inflight.has(topic)) {
      this.dirty.add(topic)
      return
    }
    this.inflight.add(topic)
    const epoch = this.epoch
    void this.run(topic, epoch)
  }

  private async run(topic: InvalidationTopic, epoch: number): Promise<void> {
    const set = this.subscribers.get(topic)
    const pending = set ? [...set].map((cb) => {
      try { return Promise.resolve(cb()) } catch (error) { return Promise.reject(error) }
    }) : []
    await Promise.allSettled(pending)
    if (epoch !== this.epoch) { this.inflight.delete(topic); return }
    if (this.dirty.has(topic)) {
      this.dirty.delete(topic)
      await this.run(topic, epoch)
      return
    }
    this.inflight.delete(topic)
  }

  clearAll(): void {
    this.epoch++
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.inflight.clear()
    this.dirty.clear()
  }

  get pendingTimers(): number {
    return this.timers.size
  }
}
