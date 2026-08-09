import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS,
  NOTIFICATION_REALTIME_CHANNEL,
  NOTIFICATION_REALTIME_DEGRADED_REASONS,
  NOTIFICATION_REALTIME_HEARTBEAT_PREFIX,
  NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME,
  NOTIFICATION_REALTIME_PROBE_INTERVAL_MS,
  NOTIFICATION_REALTIME_PROTOCOL_VERSION,
  NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS,
  SSE_EVENT_AUTH_EXPIRING,
  SSE_EVENT_DEGRADED,
  SSE_EVENT_NOTIFICATION,
  SSE_EVENT_READY,
} from '../realtime/constants.js'
import {
  buildNotificationEnvelope,
  parsePgPayload,
  serializeAuthExpiring,
  serializeDegraded,
  serializeHeartbeat,
  serializeNotificationCreated,
  serializeReady,
  type NotificationEnvelopeSource,
} from '../realtime/protocol.js'

describe('SPEC-NOTIFY-RT-001 frozen protocol constants (spec 6.1 / 6.5 / D-RT-05 / D-RT-12)', () => {
  it('fixes the static channel, protocol version and listener application_name', () => {
    expect(NOTIFICATION_REALTIME_CHANNEL).toBe('monexus_notification_created_v1')
    expect(NOTIFICATION_REALTIME_PROTOCOL_VERSION).toBe(1)
    expect(NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME).toBe('monexus-notification-realtime-listener')
    expect(NOTIFICATION_REALTIME_PROBE_INTERVAL_MS).toBe(30_000)
    expect(NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
  })

  it('fixes auth expiring lead at 60s and the degraded reason enum', () => {
    expect(NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS).toBe(60_000)
    expect(NOTIFICATION_REALTIME_DEGRADED_REASONS).toEqual([
      'listener_unavailable',
      'server_shutdown',
      'slow_consumer',
    ])
    expect(SSE_EVENT_READY).toBe('stream.ready')
    expect(SSE_EVENT_NOTIFICATION).toBe('notification.created')
    expect(SSE_EVENT_AUTH_EXPIRING).toBe('auth.expiring')
    expect(SSE_EVENT_DEGRADED).toBe('stream.degraded')
  })
})

describe('parsePgPayload (spec 6.1 / D-RT-05 / NRT-006)', () => {
  it('accepts exactly v + two positive safe integer IDs', () => {
    expect(parsePgPayload('{"v":1,"notificationId":123,"recipientUserId":456}')).toEqual({
      v: 1,
      notificationId: 123,
      recipientUserId: 456,
    })
  })

  it('rejects wrong protocol version', () => {
    expect(parsePgPayload('{"v":2,"notificationId":123,"recipientUserId":456}')).toBeNull()
    expect(parsePgPayload('{"notificationId":123,"recipientUserId":456}')).toBeNull()
  })

  it('rejects non-integer, non-positive or non-safe IDs', () => {
    expect(parsePgPayload('{"v":1,"notificationId":1.5,"recipientUserId":456}')).toBeNull()
    expect(parsePgPayload('{"v":1,"notificationId":0,"recipientUserId":456}')).toBeNull()
    expect(parsePgPayload('{"v":1,"notificationId":-3,"recipientUserId":456}')).toBeNull()
    expect(parsePgPayload('{"v":1,"notificationId":"123","recipientUserId":456}')).toBeNull()
    expect(parsePgPayload('{"v":1,"notificationId":Number.MAX_SAFE_INTEGER + 2,"recipientUserId":456}')).toBeNull()
  })

  it('rejects non-JSON and extra/sensitive keys (payload is exactly 3 fields)', () => {
    expect(parsePgPayload('not-json')).toBeNull()
    expect(parsePgPayload('{"v":1,"notificationId":123,"recipientUserId":456,"title":"x"}')).toBeNull()
    expect(parsePgPayload('{"v":1,"notificationId":123,"recipientUserId":456,"cardCode":"LEAK"}')).toBeNull()
  })
})

describe('buildNotificationEnvelope allowlist (spec 6.5 / NRT-009 / AC-RT-024)', () => {
  const validSource: NotificationEnvelopeSource = {
    id: 123,
    eventType: 'order.created_merchant',
    category: 'order',
    title: '新的待处理订单',
    body: '买家兑换了商品，请尽快处理',
    level: 'info',
    deeplink: '/merchant/orders/88',
    relatedOrderId: 88,
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
    deliveryMode: 'manual_service',
    deliveryKind: 'manual',
  }

  it('builds the exact spec 6.5 fixture', () => {
    const envelope = buildNotificationEnvelope(validSource)
    expect(envelope).toEqual({
      v: 1,
      notification: {
        id: 123,
        eventType: 'order.created_merchant',
        category: 'order',
        title: '新的待处理订单',
        body: '买家兑换了商品，请尽快处理',
        level: 'info',
        deeplink: '/merchant/orders/88',
        relatedOrderId: 88,
        createdAt: '2026-08-09T12:00:00.000Z',
        deliveryMode: 'manual_service',
        deliveryKind: 'manual',
      },
    })
  })

  it('drops invalid optional deliveryMode / deliveryKind only (spec 6.5)', () => {
    const envelope = buildNotificationEnvelope({
      ...validSource,
      deliveryMode: 'instant_inventory',
      deliveryKind: 'weird_kind',
    })
    expect(envelope?.notification.deliveryMode).toBe('instant_inventory')
    expect(envelope?.notification.deliveryKind).toBeUndefined()
  })

  it('drops the whole envelope on invalid required fields', () => {
    expect(buildNotificationEnvelope({ ...validSource, id: 0 })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, eventType: 'bad event' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, eventType: 'x'.repeat(81) })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, category: 'unknown' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, title: '' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, body: 'x'.repeat(501) })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, level: 'loud' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, relatedOrderId: -1 })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, createdAt: 'not-a-date' })).toBeNull()
  })

  it('measures title/body in Unicode code points (no byte truncation)', () => {
    const emoji = '🎉'
    expect(buildNotificationEnvelope({ ...validSource, title: emoji.repeat(100) })).not.toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, title: emoji.repeat(101) })).toBeNull()
  })

  it('rejects external URL / protocol-relative / userinfo deeplinks', () => {
    expect(buildNotificationEnvelope({ ...validSource, deeplink: 'https://evil.example/x' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: '//evil.example/x' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: 'javascript:alert(1)' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: '/orders?focus=1@evil' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: '' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: '/\\\\evil.example' })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: `/orders/${String.fromCharCode(10)}x` })).toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: '/orders/合法?focus=1' })).not.toBeNull()
    expect(buildNotificationEnvelope({ ...validSource, deeplink: '/orders?focus=1#x' })?.notification.deeplink).toBe('/orders?focus=1#x')
  })

  it('never copies sensitive fields from a hostile source (AC-RT-024)', () => {
    const hostile = {
      ...validSource,
      payload: { cardCode: 'LEAKED', webhookSecret: 'S', content: 'C' },
      cardCode: 'LEAKED',
      webhookSecret: 'S',
      content: 'C',
    } as unknown as NotificationEnvelopeSource
    const envelope = buildNotificationEnvelope(hostile)
    expect(envelope).not.toBeNull()
    const frame = serializeNotificationCreated(envelope!)
    expect(frame).not.toBeNull()
    expect(frame).not.toContain('LEAKED')
    expect(frame).not.toContain('cardCode')
    expect(frame).not.toContain('webhookSecret')
    expect(frame).not.toContain('"content"')
  })
})

describe('serializers (spec 6.5 byte format)', () => {
  it('serializes stream.ready with no id line and resyncRequired', () => {
    const frame = serializeReady(new Date('2026-08-09T12:00:00.000Z'), 20_000)
    expect(frame).toBe(
      'event: stream.ready\ndata: {"v":1,"serverTime":"2026-08-09T12:00:00.000Z","heartbeatMs":20000,"resyncRequired":true}\n\n'
    )
  })

  it('serializes notification.created with frame id equal to notification.id (NRT-026)', () => {
    const envelope = buildNotificationEnvelope({
      id: 123,
      eventType: 'order.created_merchant',
      category: 'order',
      title: '新的待处理订单',
      body: '买家兑换了商品，请尽快处理',
      level: 'info',
      deeplink: '/merchant/orders/88',
      relatedOrderId: 88,
      createdAt: new Date('2026-08-09T12:00:00.000Z'),
      deliveryMode: 'manual_service',
      deliveryKind: 'manual',
    })!
    const frame = serializeNotificationCreated(envelope)!
    const lines = frame.split('\n')
    expect(lines[0]).toBe('id: 123')
    expect(lines[1]).toBe('event: notification.created')
    expect(lines[2]).toBe(
      'data: {"v":1,"notification":{"id":123,"eventType":"order.created_merchant","category":"order","title":"新的待处理订单","body":"买家兑换了商品，请尽快处理","level":"info","deeplink":"/merchant/orders/88","relatedOrderId":88,"createdAt":"2026-08-09T12:00:00.000Z","deliveryMode":"manual_service","deliveryKind":"manual"}}'
    )
  })

  it('serializes auth.expiring and stream.degraded (control events have no id line)', () => {
    const auth = serializeAuthExpiring(new Date('2026-08-09T12:15:00.000Z'))!
    expect(auth).toBe(
      'event: auth.expiring\ndata: {"v":1,"expiresAt":"2026-08-09T12:15:00.000Z"}\n\n'
    )
    const degraded = serializeDegraded('listener_unavailable', 1000)!
    expect(degraded).toBe(
      'event: stream.degraded\ndata: {"v":1,"reason":"listener_unavailable","retryAfterMs":1000}\n\n'
    )
  })

  it('serializes heartbeat as an SSE comment', () => {
    const hb = serializeHeartbeat(new Date('2026-08-09T12:00:20.000Z'))
    expect(hb).toBe(`: ${NOTIFICATION_REALTIME_HEARTBEAT_PREFIX} 2026-08-09T12:00:20.000Z\n\n`)
  })

  it('JSON-escapes newline injection so the frame stays single-line and 3 lines', () => {
    const envelope = buildNotificationEnvelope({
      id: 1,
      eventType: 'order.created_merchant',
      category: 'order',
      title: 'line1\nline2\rline3',
      body: 'b\r\nc',
      level: 'info',
      deeplink: '/orders?focus=1',
      relatedOrderId: 1,
      createdAt: new Date('2026-08-09T12:00:00.000Z'),
    })!
    const frame = serializeNotificationCreated(envelope)!
    const lines = frame.split('\n')
    expect(lines).toHaveLength(5) // id / event / data + two blank terminator lines
    expect(lines[0]).toBe('id: 1')
    expect(lines[1]).toBe('event: notification.created')
    expect(lines[2]).not.toContain('\r')
    // JSON round-trips the literal newline inside the escaped data payload.
    const data = JSON.parse(lines[2]!.slice('data: '.length))
    expect(data.notification.title).toBe('line1\nline2\rline3')
    expect(lines[2]).toContain('\\n')
  })

  it('rejects frames over the 64KiB cap', () => {
    const hugeTitle = 'x'.repeat(70_000)
    const oversized = {
      v: 1 as const,
      notification: {
        id: 1,
        eventType: 'order.created_merchant',
        category: 'order' as const,
        title: hugeTitle,
        body: 'b',
        level: 'info' as const,
        deeplink: '/orders?focus=1',
        relatedOrderId: 1,
        createdAt: '2026-08-09T12:00:00.000Z',
      },
    }
    expect(serializeNotificationCreated(oversized)).toBeNull()
    const ok = buildNotificationEnvelope({
      id: 1,
      eventType: 'order.created_merchant',
      category: 'order',
      title: 't'.repeat(100),
      body: 'b'.repeat(500),
      level: 'info',
      deeplink: '/orders?focus=1',
      relatedOrderId: 1,
      createdAt: new Date('2026-08-09T12:00:00.000Z'),
    })
    expect(ok).not.toBeNull()
    const frame = serializeNotificationCreated(ok!)
    expect(frame).not.toBeNull()
    expect(Buffer.byteLength(frame!, 'utf8')).toBeLessThanOrEqual(65_536)
  })

})
