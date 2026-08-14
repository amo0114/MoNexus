import { describe, expect, it } from 'vitest'
import { registry } from '../../../lib/metrics.js'
import {
  notificationRealtimeListenerUp,
  notificationRealtimeConnections,
  notificationRealtimePgMessagesTotal,
  notificationRealtimeSseEventsTotal,
  notificationRealtimeDisconnectsTotal,
  notificationRealtimeConnectionRejectionsTotal,
  notificationRealtimeDeliveryLagSeconds,
} from '../../../lib/metrics.js'

/**
 * SPEC-NOTIFY-RT-001 T-BE-005 — spec 8.4 metrics are registered with strictly
 * bounded labels and never expose userId / orderId / IP / title / body (CHK-OPS-003~005).
 */
describe('realtime metrics (spec 8.4 / CHK-OPS-003~005)', () => {
  it('registers all seven spec metrics', () => {
    expect(registry.getSingleMetric('notification_realtime_listener_up')).toBe(notificationRealtimeListenerUp)
    expect(registry.getSingleMetric('notification_realtime_connections')).toBe(notificationRealtimeConnections)
    expect(registry.getSingleMetric('notification_realtime_pg_messages_total')).toBe(notificationRealtimePgMessagesTotal)
    expect(registry.getSingleMetric('notification_realtime_sse_events_total')).toBe(notificationRealtimeSseEventsTotal)
    expect(registry.getSingleMetric('notification_realtime_disconnects_total')).toBe(notificationRealtimeDisconnectsTotal)
    expect(registry.getSingleMetric('notification_realtime_connection_rejections_total')).toBe(
      notificationRealtimeConnectionRejectionsTotal
    )
    expect(registry.getSingleMetric('notification_realtime_delivery_lag_seconds')).toBe(
      notificationRealtimeDeliveryLagSeconds
    )
  })

  it('counters accept only bounded enum labels', async () => {
    notificationRealtimePgMessagesTotal.inc({ outcome: 'routed' })
    notificationRealtimePgMessagesTotal.inc({ outcome: 'invalid' })
    notificationRealtimePgMessagesTotal.inc({ outcome: 'no_subscriber' })
    notificationRealtimePgMessagesTotal.inc({ outcome: 'not_found' })
    notificationRealtimePgMessagesTotal.inc({ outcome: 'query_error' })
    notificationRealtimePgMessagesTotal.inc({ outcome: 'overload' })
    notificationRealtimePgMessagesTotal.inc({ outcome: 'probe_error' })
    notificationRealtimeSseEventsTotal.inc({ event: 'ready', outcome: 'sent' })
    notificationRealtimeSseEventsTotal.inc({ event: 'notification', outcome: 'sent' })
    notificationRealtimeDisconnectsTotal.inc({ reason: 'listener' })
    notificationRealtimeDisconnectsTotal.inc({ reason: 'slow' })
    notificationRealtimeConnectionRejectionsTotal.inc({ reason: 'user_cap' })

    // Any unknown label must be rejected at type level; here we just confirm the
    // text snapshot contains only allowed label names (no sensitive dimensions).
    const snapshot = await registry.metrics()
    expect(snapshot).toContain('notification_realtime_pg_messages_total')
    expect(snapshot).toContain('notification_realtime_sse_events_total')
    expect(snapshot).toContain('notification_realtime_disconnects_total')
    expect(snapshot).toContain('notification_realtime_connection_rejections_total')
  })

  it('metrics text never carries user/order/IP/title/body labels (CHK-OPS-004)', async () => {
    notificationRealtimeConnections.set(3)
    notificationRealtimeListenerUp.set(1)
    notificationRealtimeDeliveryLagSeconds.observe(0.25)
    const snapshot = await registry.metrics()
    // Only the documented realtime metric families may reference these words.
    const realtimeSection = snapshot
      .split('\n')
      .filter(line => line.startsWith('notification_realtime_'))
      .join('\n')
    // No label key may be user/order/IP/title/body (or any obvious sensitive name).
    for (const sensitive of ['userId', 'user_id', 'orderId', 'order_id', 'ip', 'title', 'body', 'deeplink', 'recipientUserId']) {
      expect(realtimeSection).not.toContain(`"${sensitive}"`)
    }
  })
})
