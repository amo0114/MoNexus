import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'

/**
 * AbuseEvent is an intentionally closed vocabulary.  High-volume successful
 * requests belong in Prometheus; this table is reserved for security and
 * operator decisions that need a short-lived, explainable evidence trail.
 */
export const ABUSE_EVENT_TYPES = [
  'registration_rejected',
  'registration_rate_limited',
  'challenge_failed',
  'challenge_unavailable',
  'mail_throttled',
  'email_verification_succeeded',
  'referral_qualified',
  'referral_quota_exhausted',
  'reward_granted',
  'reward_voided',
  'referral_suspended',
  'referral_restored',
] as const

export type AbuseEventType = typeof ABUSE_EVENT_TYPES[number]

export const REGISTRATION_REJECTION_REASONS = [
  'registration_disabled',
  'validation_failed',
  'email_already_registered',
] as const
export type RegistrationRejectionReason = typeof REGISTRATION_REJECTION_REASONS[number]

export const REGISTRATION_RATE_LIMIT_RULES = [
  'provider_preflight',
  'ip_hour',
  'ip_day',
  'email_day',
] as const
export type RegistrationRateLimitRule = typeof REGISTRATION_RATE_LIMIT_RULES[number]

export const CHALLENGE_FAILURE_REASONS = [
  'missing_token',
  'invalid_token',
  'provider_rejected',
] as const
export type ChallengeFailureReason = typeof CHALLENGE_FAILURE_REASONS[number]

export const CHALLENGE_UNAVAILABLE_REASONS = [
  'configuration',
  'network',
  'timeout',
  'provider_error',
] as const
export type ChallengeUnavailableReason = typeof CHALLENGE_UNAVAILABLE_REASONS[number]

export const MAIL_KINDS = ['verification', 'password_reset'] as const
export type MailKind = typeof MAIL_KINDS[number]

export const MAIL_LIMIT_DIMENSIONS = ['user', 'email', 'ip'] as const
export type MailLimitDimension = typeof MAIL_LIMIT_DIMENSIONS[number]

export const REFERRAL_QUOTA_LIMITS = ['daily', 'lifetime'] as const
export type ReferralQuotaLimit = typeof REFERRAL_QUOTA_LIMITS[number]

export const REWARD_KINDS = ['registration', 'referral'] as const
export type RewardKind = typeof REWARD_KINDS[number]

export const REWARD_VOID_REASONS = [
  'recipient_banned',
  'referral_suspended',
  'invite_relation_voided',
  'admin_void',
] as const
export type RewardVoidReason = typeof REWARD_VOID_REASONS[number]

/**
 * The only values allowed in detailSafe.  There is deliberately no generic
 * `message`, `error`, `metadata`, or object field: provider payloads and
 * request bodies must never be persisted as audit details.
 */
export type AbuseEventDetails = {
  registration_rejected: {
    reason?: RegistrationRejectionReason
  }
  registration_rate_limited: {
    rule?: RegistrationRateLimitRule
    retryAfterSeconds?: number
  }
  challenge_failed: {
    reason?: ChallengeFailureReason
  }
  challenge_unavailable: {
    reason?: ChallengeUnavailableReason
  }
  mail_throttled: {
    kind?: MailKind
    dimension?: MailLimitDimension
    retryAfterSeconds?: number
  }
  email_verification_succeeded: Record<string, never>
  referral_qualified: Record<string, never>
  referral_quota_exhausted: {
    limit?: ReferralQuotaLimit
  }
  reward_granted: {
    kind?: RewardKind
    amount?: number
  }
  reward_voided: {
    kind?: RewardKind
    reason?: RewardVoidReason
    caseRef?: string
  }
  referral_suspended: {
    caseRef?: string
  }
  referral_restored: {
    caseRef?: string
  }
}

export type RecordAbuseEventInput<T extends AbuseEventType = AbuseEventType> = {
  type: T
  userId?: number | null
  inviterId?: number | null
  inviteeId?: number | null
  /** Raw request IP. It is HMACed before persistence and never returned. */
  ip?: string | null
  /** Raw email. It is normalized and HMACed before persistence. */
  email?: string | null
  detail?: AbuseEventDetails[T] | null
}

export type AbuseEventWriter = Pick<typeof prisma, 'abuseEvent'>
export type AbuseEventHashOptions = { hashKey?: Buffer }
export type AbuseEventMaintenanceWriter = Pick<typeof prisma, 'abuseEvent'>

const ABUSE_EVENT_TYPE_SET = new Set<string>(ABUSE_EVENT_TYPES)
const REGISTRATION_REJECTION_REASON_SET = new Set<string>(REGISTRATION_REJECTION_REASONS)
const REGISTRATION_RATE_LIMIT_RULE_SET = new Set<string>(REGISTRATION_RATE_LIMIT_RULES)
const CHALLENGE_FAILURE_REASON_SET = new Set<string>(CHALLENGE_FAILURE_REASONS)
const CHALLENGE_UNAVAILABLE_REASON_SET = new Set<string>(CHALLENGE_UNAVAILABLE_REASONS)
const MAIL_KIND_SET = new Set<string>(MAIL_KINDS)
const MAIL_LIMIT_DIMENSION_SET = new Set<string>(MAIL_LIMIT_DIMENSIONS)
const REFERRAL_QUOTA_LIMIT_SET = new Set<string>(REFERRAL_QUOTA_LIMITS)
const REWARD_KIND_SET = new Set<string>(REWARD_KINDS)
const REWARD_VOID_REASON_SET = new Set<string>(REWARD_VOID_REASONS)
const SAFE_CASE_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,15}-[0-9]{1,12}$/
const MAX_SAFE_EVENT_COUNT = 100_000
const MAX_EMAIL_LENGTH = 320
const MAX_IP_LENGTH = 128
const ABUSE_HASH_VERSION = 'v1'
const ABUSE_EVENT_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1_000

type SafeScalar = string | number

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertKnownKeys(detail: Record<string, unknown>, allowedKeys: readonly string[]) {
  if (Object.keys(detail).some(key => !allowedKeys.includes(key))) {
    throw new Error('abuse event detail contains an unsupported field')
  }
}

function serializeEnum(value: unknown, allowedValues: Set<string>): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowedValues.has(value)) {
    throw new Error('abuse event detail contains an invalid controlled value')
  }
  return value
}

function serializeCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > MAX_SAFE_EVENT_COUNT) {
    throw new Error('abuse event detail contains an invalid count')
  }
  return value
}

function serializeCaseRef(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SAFE_CASE_REF_PATTERN.test(value)) {
    throw new Error('abuse event detail contains an invalid case reference')
  }
  return value
}

function addDefined(target: Record<string, SafeScalar>, key: string, value: SafeScalar | undefined) {
  if (value !== undefined) target[key] = value
}

/**
 * Convert an event's public detail to a deliberately small JSON object. This
 * is exported so route/service tests can prove that arbitrary provider or
 * request data cannot cross the audit boundary.
 */
export function serializeAbuseEventDetail<T extends AbuseEventType>(
  type: T,
  detail: AbuseEventDetails[T] | null | undefined,
): Prisma.InputJsonObject | undefined {
  if (detail === undefined || detail === null) return undefined
  if (!isPlainRecord(detail)) throw new Error('abuse event detail must be a plain object')

  const rawDetail: Record<string, unknown> = detail
  const safe: Record<string, SafeScalar> = {}

  switch (type) {
    case 'registration_rejected':
      assertKnownKeys(rawDetail, ['reason'])
      addDefined(safe, 'reason', serializeEnum(rawDetail.reason, REGISTRATION_REJECTION_REASON_SET))
      break
    case 'registration_rate_limited':
      assertKnownKeys(rawDetail, ['rule', 'retryAfterSeconds'])
      addDefined(safe, 'rule', serializeEnum(rawDetail.rule, REGISTRATION_RATE_LIMIT_RULE_SET))
      addDefined(safe, 'retryAfterSeconds', serializeCount(rawDetail.retryAfterSeconds))
      break
    case 'challenge_failed':
      assertKnownKeys(rawDetail, ['reason'])
      addDefined(safe, 'reason', serializeEnum(rawDetail.reason, CHALLENGE_FAILURE_REASON_SET))
      break
    case 'challenge_unavailable':
      assertKnownKeys(rawDetail, ['reason'])
      addDefined(safe, 'reason', serializeEnum(rawDetail.reason, CHALLENGE_UNAVAILABLE_REASON_SET))
      break
    case 'mail_throttled':
      assertKnownKeys(rawDetail, ['kind', 'dimension', 'retryAfterSeconds'])
      addDefined(safe, 'kind', serializeEnum(rawDetail.kind, MAIL_KIND_SET))
      addDefined(safe, 'dimension', serializeEnum(rawDetail.dimension, MAIL_LIMIT_DIMENSION_SET))
      addDefined(safe, 'retryAfterSeconds', serializeCount(rawDetail.retryAfterSeconds))
      break
    case 'email_verification_succeeded':
    case 'referral_qualified':
      assertKnownKeys(rawDetail, [])
      break
    case 'referral_quota_exhausted':
      assertKnownKeys(rawDetail, ['limit'])
      addDefined(safe, 'limit', serializeEnum(rawDetail.limit, REFERRAL_QUOTA_LIMIT_SET))
      break
    case 'reward_granted':
      assertKnownKeys(rawDetail, ['kind', 'amount'])
      addDefined(safe, 'kind', serializeEnum(rawDetail.kind, REWARD_KIND_SET))
      addDefined(safe, 'amount', serializeCount(rawDetail.amount))
      break
    case 'reward_voided':
      assertKnownKeys(rawDetail, ['kind', 'reason', 'caseRef'])
      addDefined(safe, 'kind', serializeEnum(rawDetail.kind, REWARD_KIND_SET))
      addDefined(safe, 'reason', serializeEnum(rawDetail.reason, REWARD_VOID_REASON_SET))
      addDefined(safe, 'caseRef', serializeCaseRef(rawDetail.caseRef))
      break
    case 'referral_suspended':
    case 'referral_restored':
      assertKnownKeys(rawDetail, ['caseRef'])
      addDefined(safe, 'caseRef', serializeCaseRef(rawDetail.caseRef))
      break
    default:
      // Keep a runtime guard for JavaScript callers even though TypeScript's
      // discriminated union makes this branch unreachable in typed code.
      throw new Error('abuse event type is unsupported')
  }

  return Object.keys(safe).length === 0 ? undefined : safe
}

function getHashKey(options: AbuseEventHashOptions): Buffer {
  const hashKey = options.hashKey ?? config.abuseHashKey
  if (!Buffer.isBuffer(hashKey) || hashKey.length !== 32) {
    // Do not include environment values or caller input in this error.
    throw new Error('abuse event hash key is unavailable')
  }
  return hashKey
}

function hashIdentifier(
  value: string | null | undefined,
  kind: 'ip' | 'email',
  options: AbuseEventHashOptions,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = kind === 'email' ? value.trim().toLowerCase() : value.trim()
  const maxLength = kind === 'email' ? MAX_EMAIL_LENGTH : MAX_IP_LENGTH
  if (!normalized || normalized.length > maxLength) return null

  return crypto
    .createHmac('sha256', getHashKey(options))
    .update(`${ABUSE_HASH_VERSION}\0${normalized}`, 'utf8')
    .digest('hex')
}

/** Derive a non-reversible correlation value for a raw IP address. */
export function hashAbuseEventIp(ip: string | null | undefined, options: AbuseEventHashOptions = {}): string | null {
  return hashIdentifier(ip, 'ip', options)
}

/** Derive a non-reversible correlation value for a normalized email address. */
export function hashAbuseEventEmail(email: string | null | undefined, options: AbuseEventHashOptions = {}): string | null {
  return hashIdentifier(email, 'email', options)
}

function validateOptionalId(value: number | null | undefined, field: string) {
  if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`abuse event ${field} must be a positive integer`)
  }
}

/**
 * Build the exact Prisma payload without retaining raw identifiers or free
 * form detail. The hash key is independent from JWT/MFA keys and is required
 * whenever a caller supplies an IP or email.
 */
export function serializeAbuseEvent<T extends AbuseEventType>(
  input: RecordAbuseEventInput<T>,
  options: AbuseEventHashOptions = {},
): Prisma.AbuseEventUncheckedCreateInput {
  if (!isPlainRecord(input) || !ABUSE_EVENT_TYPE_SET.has(input.type)) {
    throw new Error('abuse event type is unsupported')
  }
  validateOptionalId(input.userId, 'userId')
  validateOptionalId(input.inviterId, 'inviterId')
  validateOptionalId(input.inviteeId, 'inviteeId')

  const detailSafe = serializeAbuseEventDetail(input.type, input.detail)

  return {
    type: input.type,
    userId: input.userId ?? null,
    inviterId: input.inviterId ?? null,
    inviteeId: input.inviteeId ?? null,
    ipHash: hashAbuseEventIp(input.ip, options),
    emailHash: hashAbuseEventEmail(input.email, options),
    ...(detailSafe ? { detailSafe } : {}),
  }
}

/** Persist a validated abuse event, optionally inside a Prisma transaction. */
export async function recordAbuseEvent<T extends AbuseEventType>(
  input: RecordAbuseEventInput<T>,
  client: AbuseEventWriter = prisma,
  options: AbuseEventHashOptions = {},
) {
  return client.abuseEvent.create({ data: serializeAbuseEvent(input, options) })
}

export function getAbuseEventRetentionCutoff(
  now: Date = new Date(),
  retentionDays = ABUSE_EVENT_RETENTION_DAYS,
): Date {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('abuse event retention parameters are invalid')
  }
  return new Date(timestamp - retentionDays * DAY_MS)
}

/** Delete only events older than the retention cutoff; no application scan. */
export async function cleanupAbuseEvents(options: {
  now?: Date
  retentionDays?: number
  client?: AbuseEventMaintenanceWriter
} = {}): Promise<number> {
  const cutoff = getAbuseEventRetentionCutoff(options.now, options.retentionDays)
  const result = await (options.client ?? prisma).abuseEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })
  return result.count
}

export { ABUSE_EVENT_RETENTION_DAYS }
