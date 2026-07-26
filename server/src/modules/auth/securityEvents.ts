import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'

/**
 * SecurityEvent is an intentionally closed audit vocabulary. Keeping this
 * list in one place prevents callers from turning the table into a free-form
 * log that could accidentally retain credentials or request payloads.
 */
export const SECURITY_EVENT_TYPES = [
  'mfa_enrolled',
  'mfa_login_succeeded',
  'mfa_login_failed',
  'mfa_recovery_used',
  'session_revoked',
  'session_replay_detected',
  'mfa_break_glass_reset',
] as const

export type SecurityEventType = typeof SECURITY_EVENT_TYPES[number]

export const MFA_VERIFICATION_METHODS = ['totp', 'recovery_code'] as const
export type MfaVerificationMethod = typeof MFA_VERIFICATION_METHODS[number]

export const MFA_LOGIN_FAILURE_REASONS = [
  'invalid_code',
  'challenge_expired',
  'challenge_consumed',
  'challenge_attempt_limit',
] as const
export type MfaLoginFailureReason = typeof MFA_LOGIN_FAILURE_REASONS[number]

export const SESSION_REVOCATION_REASONS = [
  'logout',
  'single_session',
  'revoke_others',
  'revoke_all',
  'mfa_reconfigured',
  'mfa_break_glass_reset',
  'mfa_migration',
  'refresh_replay',
] as const
export type SessionRevocationReason = typeof SESSION_REVOCATION_REASONS[number]

/**
 * These are the only fields accepted in detailSafe. Values intentionally have
 * no free-form request text: only controlled enums, bounded counts, and a
 * short operations case reference are persisted. A caseRef is intentionally a
 * ticket-like identifier (for example, OPS-123), never free-form commentary.
 */
export type SecurityEventDetails = {
  mfa_enrolled: {
    method?: 'totp'
    recoveryCodeCount?: number
  }
  mfa_login_succeeded: {
    method?: MfaVerificationMethod
  }
  mfa_login_failed: {
    method?: MfaVerificationMethod
    reason?: MfaLoginFailureReason
  }
  mfa_recovery_used: {
    remainingRecoveryCodes?: number
  }
  session_revoked: {
    reason?: SessionRevocationReason
    revokedCount?: number
  }
  session_replay_detected: {
    action?: 'revoke_all_user_sessions'
    revokedCount?: number
  }
  mfa_break_glass_reset: {
    caseRef?: string
    revokedCount?: number
  }
}

export type RecordSecurityEventInput<T extends SecurityEventType = SecurityEventType> = {
  type: T
  userId?: number | null
  sessionId?: string | null
  /** Raw request IP; it is HMACed before persistence and never returned. */
  ip?: string | null
  /** Raw user-agent; it is reduced to a fixed browser/platform hint. */
  userAgent?: string | null
  detail?: SecurityEventDetails[T] | null
}

export type SecurityEventWriter = Pick<typeof prisma, 'securityEvent'>

const SECURITY_EVENT_TYPE_SET = new Set<string>(SECURITY_EVENT_TYPES)
const MFA_VERIFICATION_METHOD_SET = new Set<string>(MFA_VERIFICATION_METHODS)
const MFA_LOGIN_FAILURE_REASON_SET = new Set<string>(MFA_LOGIN_FAILURE_REASONS)
const SESSION_REVOCATION_REASON_SET = new Set<string>(SESSION_REVOCATION_REASONS)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_CASE_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,15}-[0-9]{1,12}$/
const MAX_SAFE_EVENT_COUNT = 100_000

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertKnownKeys(detail: Record<string, unknown>, allowedKeys: readonly string[]) {
  if (Object.keys(detail).some(key => !allowedKeys.includes(key))) {
    throw new Error('security event detail contains an unsupported field')
  }
}

function serializeEnum(value: unknown, allowedValues: Set<string>): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowedValues.has(value)) {
    throw new Error('security event detail contains an invalid controlled value')
  }
  return value
}

function serializeCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_EVENT_COUNT) {
    throw new Error('security event detail contains an invalid count')
  }
  return value
}

function serializeCaseRef(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SAFE_CASE_REF_PATTERN.test(value)) {
    throw new Error('security event detail contains an invalid safe summary')
  }
  return value
}

function addDefined(target: Record<string, string | number>, key: string, value: string | number | undefined) {
  if (value !== undefined) target[key] = value
}

/**
 * Converts the public event input to a deliberately small JSON object. This
 * function is exported so tests and future serializers can verify that a
 * caller cannot sneak raw request data into detailSafe.
 */
export function serializeSecurityEventDetail<T extends SecurityEventType>(
  type: T,
  detail: SecurityEventDetails[T] | null | undefined,
): Prisma.InputJsonObject | undefined {
  if (detail === undefined || detail === null) return undefined
  if (!isPlainRecord(detail)) throw new Error('security event detail must be a plain object')

  // Generic indexed access cannot be narrowed from `type` inside a runtime
  // switch. Once the plain-object guard succeeds, validate the same dynamic
  // record against the closed per-event contract below.
  const rawDetail: Record<string, unknown> = detail
  const safe: Record<string, string | number> = {}

  switch (type) {
    case 'mfa_enrolled': {
      assertKnownKeys(rawDetail, ['method', 'recoveryCodeCount'])
      const method = serializeEnum(rawDetail.method, new Set(['totp']))
      addDefined(safe, 'method', method)
      addDefined(safe, 'recoveryCodeCount', serializeCount(rawDetail.recoveryCodeCount))
      break
    }
    case 'mfa_login_succeeded': {
      assertKnownKeys(rawDetail, ['method'])
      addDefined(safe, 'method', serializeEnum(rawDetail.method, MFA_VERIFICATION_METHOD_SET))
      break
    }
    case 'mfa_login_failed': {
      assertKnownKeys(rawDetail, ['method', 'reason'])
      addDefined(safe, 'method', serializeEnum(rawDetail.method, MFA_VERIFICATION_METHOD_SET))
      addDefined(safe, 'reason', serializeEnum(rawDetail.reason, MFA_LOGIN_FAILURE_REASON_SET))
      break
    }
    case 'mfa_recovery_used': {
      assertKnownKeys(rawDetail, ['remainingRecoveryCodes'])
      addDefined(safe, 'remainingRecoveryCodes', serializeCount(rawDetail.remainingRecoveryCodes))
      break
    }
    case 'session_revoked': {
      assertKnownKeys(rawDetail, ['reason', 'revokedCount'])
      addDefined(safe, 'reason', serializeEnum(rawDetail.reason, SESSION_REVOCATION_REASON_SET))
      addDefined(safe, 'revokedCount', serializeCount(rawDetail.revokedCount))
      break
    }
    case 'session_replay_detected': {
      assertKnownKeys(rawDetail, ['action', 'revokedCount'])
      addDefined(safe, 'action', serializeEnum(rawDetail.action, new Set(['revoke_all_user_sessions'])))
      addDefined(safe, 'revokedCount', serializeCount(rawDetail.revokedCount))
      break
    }
    case 'mfa_break_glass_reset': {
      assertKnownKeys(rawDetail, ['caseRef', 'revokedCount'])
      addDefined(safe, 'caseRef', serializeCaseRef(rawDetail.caseRef))
      addDefined(safe, 'revokedCount', serializeCount(rawDetail.revokedCount))
      break
    }
    default: {
      // TypeScript exhaustiveness is not enough for JavaScript callers.
      throw new Error('security event type is unsupported')
    }
  }

  return Object.keys(safe).length === 0 ? undefined : safe
}

/**
 * Derive a non-reversible correlation value for an IP address. The raw IP is
 * intentionally never returned from this module or sent to Prisma.
 */
export function hashSecurityEventIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null
  const normalized = ip.trim()
  if (normalized.length === 0 || normalized.length > 128) return null

  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(normalized)
    .digest('hex')
}

/**
 * Reduce an arbitrary user-agent to a fixed, non-identifying hint. No portion
 * of the original user-agent is copied into the result.
 */
export function getSecurityEventDeviceHint(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) return null

  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /OPR\//i.test(userAgent)
      ? 'Opera'
      : /Firefox\//i.test(userAgent)
        ? 'Firefox'
        : /(?:Chrome|CriOS)\//i.test(userAgent)
          ? 'Chrome'
          : /Version\/[^ ]+.*Safari\//i.test(userAgent)
            ? 'Safari'
            : /bot|crawler|spider/i.test(userAgent)
              ? 'Automated client'
              : 'Unknown browser'

  const platform = /iPad|iPhone|iPod/i.test(userAgent)
    ? 'iOS'
    : /Android/i.test(userAgent)
      ? 'Android'
      : /Windows/i.test(userAgent)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(userAgent)
          ? 'macOS'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : 'Unknown device'

  return `${browser} · ${platform}`
}

/**
 * Build the exact database payload without retaining raw IP, user-agent, or
 * arbitrary detail fields. It is kept separate from the write for direct
 * serialization tests and transaction-safe callers.
 */
export function serializeSecurityEvent<T extends SecurityEventType>(
  input: RecordSecurityEventInput<T>,
): Prisma.SecurityEventUncheckedCreateInput {
  if (!SECURITY_EVENT_TYPE_SET.has(input.type)) {
    throw new Error('security event type is unsupported')
  }
  if (input.userId !== undefined && input.userId !== null && (!Number.isSafeInteger(input.userId) || input.userId < 1)) {
    throw new Error('security event userId must be a positive integer')
  }
  if (input.sessionId !== undefined && input.sessionId !== null && !UUID_PATTERN.test(input.sessionId)) {
    throw new Error('security event sessionId must be a UUID')
  }

  const detailSafe = serializeSecurityEventDetail(input.type, input.detail)

  return {
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    type: input.type,
    ipHash: hashSecurityEventIp(input.ip),
    deviceHint: getSecurityEventDeviceHint(input.userAgent),
    ...(detailSafe ? { detailSafe } : {}),
  }
}

/**
 * Persist a closed-vocabulary security audit event. Pass a Prisma transaction
 * client when the event must be atomic with an MFA or session-state change.
 */
export async function recordSecurityEvent<T extends SecurityEventType>(
  input: RecordSecurityEventInput<T>,
  client: SecurityEventWriter = prisma,
) {
  return client.securityEvent.create({ data: serializeSecurityEvent(input) })
}
