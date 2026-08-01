import { describe, expect, it, beforeEach } from 'vitest'
import {
  ABUSE_EVENT_TYPES,
  cleanupAbuseEvents,
  hashAbuseEventEmail,
  hashAbuseEventIp,
  recordAbuseEvent,
  serializeAbuseEvent,
  serializeAbuseEventDetail,
  type AbuseEventWriter,
  type AbuseEventMaintenanceWriter,
} from '../modules/auth/abuseEvents.js'
import {
  ABUSE_METRIC_FLOWS,
  ABUSE_METRIC_OUTCOMES,
  ABUSE_METRIC_REASONS,
  abuseEventsTotal,
  abuseOperationDuration,
  observeAbuseOperationDuration,
  recordAbuseMetric,
  registry,
} from '../lib/metrics.js'

const HASH_KEY = Buffer.alloc(32, 0x42)

function createWriter() {
  const writes: Array<Record<string, unknown>> = []
  const writer = {
    abuseEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data)
        return data
      },
    },
  } as unknown as AbuseEventWriter
  return { writer, writes }
}

describe('RAP AbuseEvent vocabulary and privacy boundary', () => {
  it('accepts the closed event vocabulary and persists only HMACs plus safe detail', async () => {
    const { writer, writes } = createWriter()
    const rawIp = '203.0.113.77'
    const rawEmail = '  Abuse-Canary@Example.COM '
    const rawProviderPayload = 'provider response must never be persisted'

    await recordAbuseEvent({
      type: 'registration_rate_limited',
      userId: 7,
      ip: rawIp,
      email: rawEmail,
      detail: { rule: 'email_day', retryAfterSeconds: 86_400 },
    }, writer, { hashKey: HASH_KEY })

    const persisted = writes[0]
    const persistedJson = JSON.stringify(persisted)
    expect(persisted).toMatchObject({
      type: 'registration_rate_limited',
      userId: 7,
      inviterId: null,
      inviteeId: null,
      ipHash: hashAbuseEventIp(rawIp, { hashKey: HASH_KEY }),
      emailHash: hashAbuseEventEmail(rawEmail, { hashKey: HASH_KEY }),
      detailSafe: { rule: 'email_day', retryAfterSeconds: 86_400 },
    })
    expect(persistedJson).not.toContain(rawIp)
    expect(persistedJson).not.toContain('Abuse-Canary@Example.COM')
    expect(persistedJson).not.toContain(rawProviderPayload)
    expect(ABUSE_EVENT_TYPES).toContain('challenge_failed')
    expect(ABUSE_EVENT_TYPES).toContain('reward_voided')
  })

  it('rejects unknown events, unknown detail keys, free-form reasons, and unsafe identifiers', () => {
    expect(() => serializeAbuseEvent({ type: 'not_in_vocabulary' as never }, { hashKey: HASH_KEY }))
      .toThrow('abuse event type is unsupported')
    expect(() => serializeAbuseEventDetail(
      'challenge_failed',
      { reason: 'provider_rejected', message: 'raw provider text' } as never,
    )).toThrow('abuse event detail contains an unsupported field')
    expect(() => serializeAbuseEventDetail(
      'registration_rejected',
      { reason: 'raw free-form reason' } as never,
    )).toThrow('abuse event detail contains an invalid controlled value')
    expect(() => serializeAbuseEventDetail(
      'reward_voided',
      { reason: 'admin_void', caseRef: 'not-a-case' } as never,
    )).toThrow('abuse event detail contains an invalid case reference')
    expect(() => serializeAbuseEvent(
      { type: 'reward_granted', userId: 0 },
      { hashKey: HASH_KEY },
    )).toThrow('abuse event userId must be a positive integer')
  })

  it('requires the independent 32-byte HMAC key when a raw identifier is supplied', () => {
    expect(() => hashAbuseEventIp('203.0.113.78')).toThrow('abuse event hash key is unavailable')
    expect(() => hashAbuseEventEmail('canary@example.com', { hashKey: Buffer.alloc(31) }))
      .toThrow('abuse event hash key is unavailable')
    expect(hashAbuseEventIp(null, { hashKey: HASH_KEY })).toBeNull()
    expect(hashAbuseEventEmail('  CANARY@EXAMPLE.COM  ', { hashKey: HASH_KEY }))
      .toBe(hashAbuseEventEmail('canary@example.com', { hashKey: HASH_KEY }))
  })

  it('deletes only rows older than the bounded retention cutoff', async () => {
    let capturedWhere: unknown
    const maintenance = {
      abuseEvent: {
        deleteMany: async ({ where }: { where: unknown }) => {
          capturedWhere = where
          return { count: 3 }
        },
      },
    } as unknown as AbuseEventMaintenanceWriter

    await expect(cleanupAbuseEvents({
      now: new Date('2026-08-01T00:00:00.000Z'),
      client: maintenance,
    })).resolves.toBe(3)
    expect(capturedWhere).toEqual({
      createdAt: { lt: new Date('2026-05-03T00:00:00.000Z') },
    })
  })
})

describe('RAP abuse metrics cardinality boundary', () => {
  beforeEach(() => {
    abuseEventsTotal.reset()
    abuseOperationDuration.reset()
  })

  it('exposes only fixed flow/outcome/reason labels and records safe observations', async () => {
    expect(ABUSE_METRIC_FLOWS).toEqual([
      'registration',
      'challenge',
      'verification_email',
      'password_reset',
      'email_verification',
      'referral',
      'reward',
    ])
    expect(ABUSE_METRIC_OUTCOMES).toContain('rate_limited')
    expect(ABUSE_METRIC_FLOWS).not.toContain('203.0.113.77' as never)
    expect(ABUSE_METRIC_REASONS).not.toContain('canary@example.com' as never)

    recordAbuseMetric({ flow: 'registration', outcome: 'rate_limited', reason: 'rate_limited' })
    recordAbuseMetric({ flow: 'email_verification', outcome: 'succeeded' })
    observeAbuseOperationDuration({ flow: 'challenge', outcome: 'failed' }, 0.2)

    const exposition = await registry.metrics()
    expect(exposition).toContain('monexus_abuse_events_total')
    expect(exposition).toContain('flow="registration"')
    expect(exposition).toContain('outcome="rate_limited"')
    expect(exposition).toContain('reason="rate_limited"')
    expect(exposition).toContain('monexus_abuse_operation_duration_seconds')
  })

  it('rejects labels outside the finite vocabulary before incrementing', () => {
    expect(() => recordAbuseMetric({
      flow: 'registration',
      outcome: 'rejected',
      reason: 'raw-provider-error' as never,
    })).toThrow('abuse metric labels must use the fixed vocabulary')
    expect(() => observeAbuseOperationDuration(
      { flow: 'challenge', outcome: 'failed' },
      Number.NaN,
    )).toThrow('abuse operation duration must be a non-negative finite number')
  })
})
