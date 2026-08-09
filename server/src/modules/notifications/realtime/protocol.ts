/**
 * SPEC-NOTIFY-RT-001 — realtime protocol: PG payload validation and SSE envelope
 * allowlist + serializer (spec 6.1 / 6.5). This is the ONLY serializer used by
 * listener / streamController; no other module hand-builds SSE (plan 3.1).
 *
 * Responsibilities:
 *  - Parse/validate the 3-field PG NOTIFY payload (D-RT-05, NRT-006).
 *  - Project a DB notification row into the safe SSE envelope via a strict
 *    allowlist (NRT-007/NRT-009, spec 6.5). Invalid required fields drop the
 *    envelope; invalid optional deliveryMode/deliveryKind drop only that field.
 *  - Serialize single-line UTF-8 SSE frames; JSON.stringify escapes embedded
 *    newlines, so newline injection cannot break a frame. Frames over the cap
 *    are rejected. Sensitive fields are never copied into the envelope.
 */
import {
  NOTIFICATION_REALTIME_MAX_FRAME_BYTES,
  NOTIFICATION_REALTIME_PROTOCOL_VERSION,
  SSE_EVENT_AUTH_EXPIRING,
  SSE_EVENT_DEGRADED,
  SSE_EVENT_NOTIFICATION,
  SSE_EVENT_READY,
  type NotificationRealtimeDegradedReason,
} from './constants.js'

export const NOTIFICATION_CATEGORIES = ['order', 'provision', 'booking', 'inventory', 'system'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'critical'] as const
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]

export const NOTIFICATION_DELIVERY_MODES = ['manual_service', 'instant_inventory', 'instant_fixed'] as const
export type NotificationDeliveryMode = (typeof NOTIFICATION_DELIVERY_MODES)[number]

export const NOTIFICATION_DELIVERY_KINDS = ['manual', 'instant', 'faka', 'auto'] as const
export type NotificationDeliveryKind = (typeof NOTIFICATION_DELIVERY_KINDS)[number]

export interface PgPayload {
  v: 1
  notificationId: number
  recipientUserId: number
}

export interface NotificationEnvelope {
  v: 1
  notification: {
    id: number
    eventType: string
    category: NotificationCategory
    title: string
    body: string
    level: NotificationLevel
    deeplink: string
    relatedOrderId: number | null
    createdAt: string
    deliveryMode?: NotificationDeliveryMode
    deliveryKind?: NotificationDeliveryKind
  }
}

/**
 * Raw values as read from the primary DB (service allowlist projection).
 * deliveryMode / deliveryKind are optional and come from the payload allowlist.
 */
export interface NotificationEnvelopeSource {
  id: number
  eventType: string
  category: string
  title: string
  body: string
  level: string
  deeplink: string
  relatedOrderId: number | null
  createdAt: Date | string
  deliveryMode?: string | null
  deliveryKind?: string | null
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** ASCII letters / digits / dot / underscore / hyphen, 1-80 chars (spec 6.5). */
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/

/** Relative in-app path only: single leading /, no //, no scheme, no userinfo. */
function isValidDeeplink(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length < 1 || value.length > 512) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
  if (value.includes('@')) return false
  return true
}

function codePointLength(value: string): number {
  return [...value].length
}

function isValidIsoUtc(value: Date | string): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return false
  // Must round-trip to a canonical ISO-8601 UTC string.
  return parsed.toISOString() === value
}

/**
 * Parse the PG NOTIFY payload. Only `{ v: 1, notificationId, recipientUserId }`
 * with both IDs positive safe integers is accepted (D-RT-05, NRT-006).
 */
export function parsePgPayload(raw: string): PgPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.v !== NOTIFICATION_REALTIME_PROTOCOL_VERSION) return null
  if (!isPositiveSafeInteger(obj.notificationId)) return null
  if (!isPositiveSafeInteger(obj.recipientUserId)) return null
  // NRT-006: payload is exactly version + two integer IDs — reject any extra keys.
  const keys = Object.keys(obj).sort()
  if (keys.join(',') !== 'notificationId,recipientUserId,v') return null
  return {
    v: NOTIFICATION_REALTIME_PROTOCOL_VERSION,
    notificationId: obj.notificationId,
    recipientUserId: obj.recipientUserId,
  }
}

/**
 * Project a DB row into the safe SSE envelope. Returns null when the envelope
 * must be dropped (wait for REST convergence). Invalid optional delivery fields
 * are removed rather than dropping the whole envelope (spec 6.5).
 */
export function buildNotificationEnvelope(source: NotificationEnvelopeSource): NotificationEnvelope | null {
  if (!isPositiveSafeInteger(source.id)) return null
  if (!EVENT_TYPE_PATTERN.test(source.eventType)) return null
  if (!NOTIFICATION_CATEGORIES.includes(source.category as NotificationCategory)) return null
  if (typeof source.title !== 'string' || codePointLength(source.title) < 1 || codePointLength(source.title) > 100) {
    return null
  }
  if (typeof source.body !== 'string' || codePointLength(source.body) < 1 || codePointLength(source.body) > 500) {
    return null
  }
  if (!NOTIFICATION_LEVELS.includes(source.level as NotificationLevel)) return null
  if (!isValidDeeplink(source.deeplink)) return null
  if (source.relatedOrderId !== null && !isPositiveSafeInteger(source.relatedOrderId)) return null
  if (!isValidIsoUtc(source.createdAt)) return null

  const notification: NotificationEnvelope['notification'] = {
    id: source.id,
    eventType: source.eventType,
    category: source.category as NotificationCategory,
    title: source.title,
    body: source.body,
    level: source.level as NotificationLevel,
    deeplink: source.deeplink,
    relatedOrderId: source.relatedOrderId,
    createdAt: source.createdAt instanceof Date ? source.createdAt.toISOString() : source.createdAt,
  }

  if (
    typeof source.deliveryMode === 'string'
    && NOTIFICATION_DELIVERY_MODES.includes(source.deliveryMode as NotificationDeliveryMode)
  ) {
    notification.deliveryMode = source.deliveryMode as NotificationDeliveryMode
  }
  if (
    typeof source.deliveryKind === 'string'
    && NOTIFICATION_DELIVERY_KINDS.includes(source.deliveryKind as NotificationDeliveryKind)
  ) {
    notification.deliveryKind = source.deliveryKind as NotificationDeliveryKind
  }

  return { v: NOTIFICATION_REALTIME_PROTOCOL_VERSION, notification }
}

/** Serialize an SSE frame (all single-line UTF-8). Returns null if over the cap. */
function serializeFrame(lines: string[]): string | null {
  const frame = `${lines.join('\n')}\n\n`
  if (Buffer.byteLength(frame, 'utf8') > NOTIFICATION_REALTIME_MAX_FRAME_BYTES) return null
  return frame
}

/** `stream.ready` — control event, no id. */
export function serializeReady(serverTime: Date, heartbeatMs: number, resyncRequired = true): string | null {
  return serializeFrame([
    `event: ${SSE_EVENT_READY}`,
    `data: ${JSON.stringify({
      v: NOTIFICATION_REALTIME_PROTOCOL_VERSION,
      serverTime: serverTime.toISOString(),
      heartbeatMs,
      resyncRequired,
    })}`,
  ])
}

/**
 * `notification.created` — business event; frame id equals notification.id
 * (spec 6.5 / NRT-026). Returns null when the frame would exceed the cap.
 */
export function serializeNotificationCreated(envelope: NotificationEnvelope): string | null {
  return serializeFrame([
    `id: ${envelope.notification.id}`,
    `event: ${SSE_EVENT_NOTIFICATION}`,
    `data: ${JSON.stringify(envelope)}`,
  ])
}

/** `auth.expiring` — control event, no id. */
export function serializeAuthExpiring(expiresAt: Date): string | null {
  return serializeFrame([
    `event: ${SSE_EVENT_AUTH_EXPIRING}`,
    `data: ${JSON.stringify({ v: NOTIFICATION_REALTIME_PROTOCOL_VERSION, expiresAt: expiresAt.toISOString() })}`,
  ])
}

/** `stream.degraded` — control event, no id. reason is a fixed enum. */
export function serializeDegraded(reason: NotificationRealtimeDegradedReason, retryAfterMs: number): string | null {
  return serializeFrame([
    `event: ${SSE_EVENT_DEGRADED}`,
    `data: ${JSON.stringify({ v: NOTIFICATION_REALTIME_PROTOCOL_VERSION, reason, retryAfterMs })}`,
  ])
}

/** Heartbeat — SSE comment line; never triggers business UI. */
export function serializeHeartbeat(now: Date): string {
  return `: heartbeat ${now.toISOString()}\n\n`
}
