import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { loggerRedact } from '../lib/logger.js'
import {
  hashSecurityEventIp,
  recordSecurityEvent,
  serializeSecurityEvent,
  serializeSecurityEventDetail,
} from '../modules/auth/securityEvents.js'

function serializeLog(payload: Record<string, unknown>) {
  let line = ''
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      line += chunk.toString()
      callback()
    },
  })
  const testLogger = pino({ base: undefined, timestamp: false, redact: loggerRedact }, destination)

  testLogger.info(payload, 'security-event-redaction-test')
  return JSON.parse(line) as Record<string, unknown>
}

describe('security event serialization', () => {
  it('persists only an IP HMAC, a fixed device hint, and controlled detail', async () => {
    const rawIp = '203.0.113.42'
    const rawUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
    const sessionId = '8a38bf42-f3ea-4d05-9f66-0766c1e6b92a'

    const recorded = await recordSecurityEvent({
      type: 'session_revoked',
      sessionId,
      ip: rawIp,
      userAgent: rawUserAgent,
      detail: { reason: 'single_session', revokedCount: 1 },
    })

    const persistedJson = JSON.stringify(recorded)
    const detailSafe = recorded.detailSafe
    const hasOnlyControlledDetail =
      typeof detailSafe === 'object'
      && detailSafe !== null
      && !Array.isArray(detailSafe)
      && detailSafe.reason === 'single_session'
      && detailSafe.revokedCount === 1
      && Object.keys(detailSafe).every(key => key === 'reason' || key === 'revokedCount')
    const onlySafeFieldsPersisted =
      recorded.ipHash === hashSecurityEventIp(rawIp)
      && recorded.deviceHint === 'Chrome · macOS'
      && hasOnlyControlledDetail
      && !persistedJson.includes('203.0.113.')
      && !persistedJson.includes('Mozilla/')

    // The boolean assertion keeps a failure from echoing raw IP/UA values.
    expect(onlySafeFieldsPersisted).toBe(true)
  })

  it('rejects unsupported event types and arbitrary detail fields before a database write', () => {
    const rejectsUnknownEvent = () => serializeSecurityEvent({ type: 'unknown_event' as never })
    const rejectsFreeFormDetail = () => serializeSecurityEventDetail(
      'mfa_login_failed',
      { reason: 'invalid_code', untrustedPayload: true } as never,
    )

    expect(rejectsUnknownEvent).toThrow('security event type is unsupported')
    expect(rejectsFreeFormDetail).toThrow('security event detail contains an unsupported field')
  })
})

describe('Pino MFA redaction', () => {
  it('redacts MFA values in nested request and error structures without hiding unrelated audit data', () => {
    const fixtureValue = () => randomBytes(18).toString('base64url')
    const password = fixtureValue()
    const verificationPassword = fixtureValue()
    const currentPassword = fixtureValue()
    const newPassword = fixtureValue()
    const mfaCode = fixtureValue()
    const factorCode = fixtureValue()
    const recoveryCode = fixtureValue()
    const recoveryCodeSecond = fixtureValue()
    const challengeId = fixtureValue()
    const manualKey = fixtureValue()
    const mfaSecret = fixtureValue()
    const encryptedSecret = fixtureValue()
    const pendingEncryptedSecret = fixtureValue()
    const pendingSecret = fixtureValue()
    const encryptionKey = fixtureValue()

    const output = serializeLog({
      password,
      req: {
        body: {
          password,
          verificationPassword,
          currentPassword,
          newPassword,
          mfaCode,
          code: factorCode,
          recoveryCode,
          recoveryCodes: [recoveryCode, recoveryCodeSecond],
          challengeId,
          manualKey,
          provisioningUri: `otpauth://totp/${manualKey}`,
          mfaSecret,
          nested: { mfaCode },
        },
        query: { challengeId },
      },
      err: {
        mfaSecretEncrypted: encryptedSecret,
        cause: {
          body: {
            recoveryCode,
            code: factorCode,
            secretEncrypted: pendingEncryptedSecret,
            pendingSecret,
          },
        },
      },
      error: {
        context: { body: { mfaCode, code: factorCode } },
      },
      environment: { MFA_ENCRYPTION_KEY: encryptionKey },
      config: { mfaEncryptionKey: encryptionKey },
      code: 'VALIDATION_ERROR',
      order: { id: 42, status: 'paid', amount: 99 },
    }) as unknown as {
      password: unknown
      req: { body: Record<string, unknown>; query: Record<string, unknown> }
      err: { mfaSecretEncrypted: unknown; cause: { body: Record<string, unknown> } }
      error: { context: { body: Record<string, unknown> } }
      environment: Record<string, unknown>
      config: Record<string, unknown>
      code: string
      order: { id: number; status: string; amount: number }
    }

    const fieldsToCheck = {
      password: output.password,
      requestPassword: output.req.body.password,
      verificationPassword: output.req.body.verificationPassword,
      currentPassword: output.req.body.currentPassword,
      newPassword: output.req.body.newPassword,
      mfaCode: output.req.body.mfaCode,
      factorCode: output.req.body.code,
      recoveryCode: output.req.body.recoveryCode,
      recoveryCodes: output.req.body.recoveryCodes,
      challengeId: output.req.body.challengeId,
      manualKey: output.req.body.manualKey,
      provisioningUri: output.req.body.provisioningUri,
      mfaSecret: output.req.body.mfaSecret,
      nestedMfaCode: (output.req.body.nested as Record<string, unknown>).mfaCode,
      queryChallengeId: output.req.query.challengeId,
      encryptedUserSecret: output.err.mfaSecretEncrypted,
      causeRecoveryCode: output.err.cause.body.recoveryCode,
      causeFactorCode: output.err.cause.body.code,
      pendingEncryptedSecret: output.err.cause.body.secretEncrypted,
      pendingSecret: output.err.cause.body.pendingSecret,
      contextMfaCode: output.error.context.body.mfaCode,
      contextFactorCode: output.error.context.body.code,
      encryptionKey: output.environment.MFA_ENCRYPTION_KEY,
      configEncryptionKey: output.config.mfaEncryptionKey,
    }
    const unredactedFieldNames = Object.entries(fieldsToCheck)
      .filter(([, value]) => value !== '[redacted]')
      .map(([field]) => field)

    // A failure lists only field names, never dynamically generated secrets.
    expect(unredactedFieldNames).toEqual([])
    expect(output.code).toBe('VALIDATION_ERROR')
    expect(output.order).toEqual({ id: 42, status: 'paid', amount: 99 })
  })
})
