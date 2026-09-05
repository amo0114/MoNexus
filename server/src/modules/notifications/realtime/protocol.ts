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
  SSE_EVENT_NOTIFICATION_READ,
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
  /** 判别字段：created 提示（历史形态）不携带 kind。 */
  kind?: undefined
  notificationId: number
  recipientUserId: number
}

/** PR-5：已读失效提示（无 notificationId——不锚定任何单条通知）。 */
export interface PgReadPayload {
  v: 1
  kind: 'read'
  recipientUserId: number
}

export type PgMessagePayload = PgPayload | PgReadPayload

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
  // Backslashes are normalized by WHATWG URL parsing and can turn a relative
  // path into an authority (e.g. /\\evil.example).
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
  if (value.includes('@')) return false
  try {
    const base = 'https://monexus.invalid'
    const resolved = new URL(value, base)
    return resolved.origin === base && resolved.pathname.startsWith('/')
  } catch {
    return false
  }
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
 * Parse the PG NOTIFY payload. Two exact shapes are accepted (D-RT-05, NRT-006):
 * - `{ v: 1, notificationId, recipientUserId }` — created hint (legacy shape,
 *   kindless for backward compatibility with in-flight rows of older versions);
 * - `{ v: 1, kind: 'read', recipientUserId }` — read invalidation hint (PR-5).
 * Both IDs must be positive safe integers; any extra keys reject the payload.
 */
export function parsePgPayload(raw: string): PgMessagePayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.v !== NOTIFICATION_REALTIME_PROTOCOL_VERSION) return null
  if (!isPositiveSafeInteger(obj.recipientUserId)) return null
  if (obj.kind === 'read') {
    const keys = Object.keys(obj).sort()
    if (keys.join(',') !== 'kind,recipientUserId,v') return null
    return { v: NOTIFICATION_REALTIME_PROTOCOL_VERSION, kind: 'read', recipientUserId: obj.recipientUserId }
  }
  if (!isPositiveSafeInteger(obj.notificationId)) return null
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
 * Build the canonical PG NOTIFY payload string used by the dispatcher (D-RT-05).
 * Only the version and two positive safe integer IDs — nothing else may enter.
 */
export function serializePgPayload(notificationId: number, recipientUserId: number): string {
  if (!isPositiveSafeInteger(notificationId) || !isPositiveSafeInteger(recipientUserId)) {
    throw new Error('serializePgPayload requires positive safe integer IDs')
  }
  return JSON.stringify({
    v: NOTIFICATION_REALTIME_PROTOCOL_VERSION,
    notificationId,
    recipientUserId,
  })
}

/**
 * PR-5：已读失效提示的 PG NOTIFY 载荷。只含版本、kind 与接收者 id——
 * 绝不携带通知正文、业务 payload 或任何用户信息。
 */
export function serializeReadPgPayload(recipientUserId: number): string {
  if (!isPositiveSafeInteger(recipientUserId)) {
    throw new Error('serializeReadPgPayload requires a positive safe integer user id')
  }
  return JSON.stringify({
    v: NOTIFICATION_REALTIME_PROTOCOL_VERSION,
    kind: 'read',
    recipientUserId,
  })
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

/**
 * PR-5：`notification.read` — control event, no id, no business payload.
 * 同用户其他连接收到后只刷新未读数（REST 收敛），绝不做任何 UI 提示。
 */
export function serializeNotificationRead(): string | null {
  return serializeFrame([
    `event: ${SSE_EVENT_NOTIFICATION_READ}`,
    `data: ${JSON.stringify({ v: NOTIFICATION_REALTIME_PROTOCOL_VERSION })}`,
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
