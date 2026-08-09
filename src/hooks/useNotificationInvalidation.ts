/**
 * SPEC-NOTIFY-RT-001 — page subscription hook (T-FE-002 / REQ-F-009).
 *
 * Pages reuse their own load functions; this hook just subscribes to a typed
 * invalidation topic so the realtime bridge can trigger reloads without any
 * page coupling to the stream internals.
 */
import { useEffect, useRef } from 'react'
import type { InvalidationTopic } from '../realtime/notificationInvalidation.js'
import { getInvalidationScheduler } from '../realtime/runtime.js'

export function useNotificationInvalidation(topic: InvalidationTopic, onInvalidate: () => void): void {
  const cbRef = useRef(onInvalidate)
  cbRef.current = onInvalidate

  useEffect(() => {
    const unsubscribe = getInvalidationScheduler().subscribe(topic, () => cbRef.current())
    return unsubscribe
  }, [topic])
}
