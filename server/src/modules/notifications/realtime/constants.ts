/**
 * SPEC-NOTIFY-RT-001 — realtime notification protocol constants.
 * The static channel / event names / auth lead are frozen decisions (D-RT-05,
 * D-RT-12, spec 6.1/6.5). None of these may come from requests, users, or env.
 */

/** Static PostgreSQL LISTEN/NOTIFY channel. Never derived from user/env input (D-RT-05, NRT-006). */
export const NOTIFICATION_REALTIME_CHANNEL = 'monexus_notification_created_v1'

/** Wire protocol version for PG payloads and SSE envelopes (spec 6.1 / 6.5). */
export const NOTIFICATION_REALTIME_PROTOCOL_VERSION = 1 as const

/**
 * Lead time (ms) before access-token expiry at which the server emits a single
 * `auth.expiring` event (D-RT-12, spec 6.5). Access token TTL is fixed at 15m.
 */
export const NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS = 60_000

/** SSE event names (spec 6.5) — control events carry no id, business events carry id. */
export const SSE_EVENT_READY = 'stream.ready'
export const SSE_EVENT_NOTIFICATION = 'notification.created'
export const SSE_EVENT_AUTH_EXPIRING = 'auth.expiring'
export const SSE_EVENT_DEGRADED = 'stream.degraded'

/** `stream.degraded` reason enum (spec 6.5). */
export const NOTIFICATION_REALTIME_DEGRADED_REASONS = [
  'listener_unavailable',
  'server_shutdown',
  'slow_consumer',
] as const
export type NotificationRealtimeDegradedReason = (typeof NOTIFICATION_REALTIME_DEGRADED_REASONS)[number]

/** Heartbeat SSE comment prefix; payload is a human/ops timestamp (spec 6.5). */
export const NOTIFICATION_REALTIME_HEARTBEAT_PREFIX = 'heartbeat'

/** Dedicated LISTEN connection application_name (spec 6.2). */
export const NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME = 'monexus-notification-realtime-listener'

/** LISTEN keepalive probe interval (spec 6.2). */
export const NOTIFICATION_REALTIME_PROBE_INTERVAL_MS = 30_000

/** Exponential reconnect delays with ±20% jitter applied by the caller (spec 6.2). */
export const NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/**
 * Max serialized SSE frame size. Frames that would exceed this are rejected by
 * the serializer instead of being emitted (defense for the 64KiB client cap).
 */
export const NOTIFICATION_REALTIME_MAX_FRAME_BYTES = 65_536

/** Payload JSON UTF-8 byte budget — far below PostgreSQL's 8KB NOTIFY limit. */
export const NOTIFICATION_REALTIME_MAX_PG_PAYLOAD_BYTES = 8_000

/** Spec 8.4 metric labels (strict enum). */
export const NOTIFICATION_REALTIME_PG_OUTCOMES = [
  'routed',
  'invalid',
  'no_subscriber',
  'not_found',
  'query_error',
] as const
/** Message-terminal outcomes counted into cluster wakeups (spec 8.5). */
export type NotificationRealtimePgMessageOutcome = (typeof NOTIFICATION_REALTIME_PG_OUTCOMES)[number]
/** Includes probe_error, which is a probe result, not a message rate (spec 8.4/8.5). */
export type NotificationRealtimePgOutcome = NotificationRealtimePgMessageOutcome | 'probe_error'
