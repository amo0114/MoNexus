/**
 * SPEC-NOTIFY-RT-001 — realtime runtime singletons (T-FE-002).
 *
 * The bridge owns the NotificationStream; the invalidation scheduler and the
 * exact-ID LRU are process-wide singletons scoped to the current user. On
 * user change / logout the bridge calls resetRealtimeRuntime() to drop LRU,
 * timers and pending topics (REQ-F-014 / CHK-FE-013).
 */
import { ExactIdLru, InvalidationScheduler } from './notificationInvalidation.js'

let schedulerSingleton: InvalidationScheduler | null = null
let lruSingleton: ExactIdLru | null = null

export function getInvalidationScheduler(): InvalidationScheduler {
  if (!schedulerSingleton) schedulerSingleton = new InvalidationScheduler()
  return schedulerSingleton
}

export function getExactIdLru(): ExactIdLru {
  if (!lruSingleton) lruSingleton = new ExactIdLru()
  return lruSingleton
}

/** Clear the current user's realtime state (LRU / timers / pending topics). */
export function resetRealtimeRuntime(): void {
  getInvalidationScheduler().clearAll()
  getExactIdLru().clear()
}
