import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import {
  mfaChallengeInvalid,
  mfaTooManyAttempts,
  mfaVerificationFailed,
  notFound,
} from '../../lib/httpError.js'
import { getRefreshTokenMaxAgeMs } from '../../lib/systemConfig.js'
import { lockUserRefreshSessionMutations, revokeAllUserRefreshTokens } from './sessionService.js'
import { recordSecurityEvent } from './securityEvents.js'
import {
  claimMfaRecoveryCode,
  consumeAuthChallenge,
  countUnusedMfaRecoveryCodes,
  createMfaProvisioningUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSeed,
  getUsableAuthChallenge,
  recordAuthChallengeFailure,
  replaceMfaRecoveryCodes,
  verifyTotp,
  type AuthChallengePurpose,
} from './mfa.js'
import { buildAuthUser, generateAccessToken, createStoredRefreshToken } from './sessionIssuance.js'

type MfaFactorMethod = 'totp' | 'recovery_code'
type MfaVerificationOutcome =
  | { kind: 'issued'; user: { id: number; email: string; role: string; status: string; nickname: string | null; mfaVersion: number; pointAccount: { balance: number } | null }; session: { refreshToken: string; maxAgeMs: number; sessionId: string }; recoveryCodes?: string[]; recoveryCodeRemaining?: number }
  | { kind: 'verification_failed' | 'too_many_attempts' | 'challenge_invalid' }

/** Forces a transaction rollback when a recovery-code claim lost its challenge race. */
class MfaChallengeChangedError extends Error {
  constructor() {
    super('MFA challenge state changed')
    this.name = 'MfaChallengeChangedError'
  }
}

async function findMfaChallengeOwner(challengeId: string, purpose: AuthChallengePurpose) {
  const pointer = await prisma.authChallenge.findFirst({
    where: { id: challengeId, purpose },
    select: { userId: true },
  })
  if (!pointer) throw mfaChallengeInvalid()
  return pointer
}

function mapChallengeLookupForEnrollment(kind: 'invalid' | 'expired' | 'too_many_attempts'): never {
  if (kind === 'too_many_attempts') throw mfaChallengeInvalid('MFA 验证请求已失效，请重新登录')
  throw mfaChallengeInvalid()
}

function mapMfaVerificationOutcome(outcome: Exclude<MfaVerificationOutcome, { kind: 'issued' }>): never {
  if (outcome.kind === 'too_many_attempts') throw mfaTooManyAttempts()
  if (outcome.kind === 'challenge_invalid') throw mfaChallengeInvalid()
  throw mfaVerificationFailed()
}

async function recordMfaFactorFailure(input: {
  tx: Prisma.TransactionClient
  userId: number
  challengeId: string
  purpose: AuthChallengePurpose
  method: MfaFactorMethod
  ip?: string
  userAgent?: string
}): Promise<'verification_failed' | 'too_many_attempts'> {
  const failure = await recordAuthChallengeFailure({
    challengeId: input.challengeId,
    userId: input.userId,
    purpose: input.purpose,
    tx: input.tx,
  })

  if (failure.kind === 'unavailable') return 'verification_failed'

  const outcome = failure.kind === 'locked' ? 'too_many_attempts' : 'verification_failed'
  await recordSecurityEvent({
    type: 'mfa_login_failed',
    userId: input.userId,
    ip: input.ip,
    userAgent: input.userAgent,
    detail: {
      method: input.method,
      reason: failure.kind === 'locked' ? 'challenge_attempt_limit' : 'invalid_code',
    },
  }, input.tx)
  return outcome
}

function isActiveAdmin(user: { role: string; status: string }) {
  return user.role === 'admin' && user.status !== '已封禁'
}

/**
 * Returns the enrollment seed only to the holder of a live pre-auth
 * challenge. The seed is generated once and stored encrypted; a retry gets
 * the same value rather than creating competing bindings.
 */
export async function startAdminMfaEnrollment(challengeId: string) {
  const pointer = await findMfaChallengeOwner(challengeId, 'admin_enroll')

  return prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, pointer.userId)
    const lookup = await getUsableAuthChallenge({
      challengeId,
      userId: pointer.userId,
      purpose: 'admin_enroll',
      tx,
    })
    if (lookup.kind !== 'active') return mapChallengeLookupForEnrollment(lookup.kind)

    const user = await tx.user.findUnique({
      where: { id: pointer.userId },
      select: { email: true, role: true, status: true, mfaEnabled: true },
    })
    if (!user || !isActiveAdmin(user) || user.mfaEnabled) throw mfaChallengeInvalid()

    let secretEncrypted = lookup.challenge.secretEncrypted
    if (!secretEncrypted) {
      const manualKey = generateTotpSeed()
      const encrypted = encryptMfaSecret(manualKey)
      const assigned = await tx.authChallenge.updateMany({
        where: {
          id: lookup.challenge.id,
          userId: pointer.userId,
          purpose: 'admin_enroll',
          consumedAt: null,
          expiresAt: { gt: new Date() },
          secretEncrypted: null,
        },
        data: { secretEncrypted: encrypted },
      })

      if (assigned.count === 1) {
        secretEncrypted = encrypted
      } else {
        const reread = await getUsableAuthChallenge({
          challengeId,
          userId: pointer.userId,
          purpose: 'admin_enroll',
          tx,
        })
        if (reread.kind !== 'active' || !reread.challenge.secretEncrypted) throw mfaChallengeInvalid()
        secretEncrypted = reread.challenge.secretEncrypted
      }
    }

    try {
      const manualKey = decryptMfaSecret(secretEncrypted)
      return {
        provisioningUri: createMfaProvisioningUri({ seed: manualKey, accountName: user.email }),
        manualKey,
        expiresAt: lookup.challenge.expiresAt,
      }
    } catch {
      // A corrupt or unavailable secret must not reveal storage/key details.
      throw mfaChallengeInvalid()
    }
  })
}

function issueMfaLoginResponse(outcome: Extract<MfaVerificationOutcome, { kind: 'issued' }>) {
  return {
    user: buildAuthUser(outcome.user, outcome.user.pointAccount?.balance ?? 0),
    accessToken: generateAccessToken(
      outcome.user.id,
      outcome.user.role,
      outcome.session.sessionId,
      { verified: true, version: outcome.user.mfaVersion },
    ),
    refreshToken: outcome.session.refreshToken,
    refreshTokenMaxAgeMs: outcome.session.maxAgeMs,
    ...(outcome.recoveryCodes === undefined ? {} : { recoveryCodes: outcome.recoveryCodes }),
    ...(outcome.recoveryCodeRemaining === undefined ? {} : { recoveryCodeRemaining: outcome.recoveryCodeRemaining }),
  }
}

export async function confirmAdminMfaEnrollment(input: {
  challengeId: string
  code: string
  ip?: string
  userAgent?: string
}) {
  const pointer = await findMfaChallengeOwner(input.challengeId, 'admin_enroll')
  const maxAgeMs = await getRefreshTokenMaxAgeMs()

  let outcome: MfaVerificationOutcome
  try {
    outcome = await prisma.$transaction(async tx => {
      await lockUserRefreshSessionMutations(tx, pointer.userId)
      const lookup = await getUsableAuthChallenge({
        challengeId: input.challengeId,
        userId: pointer.userId,
        purpose: 'admin_enroll',
        tx,
      })
      if (lookup.kind !== 'active') {
        return { kind: lookup.kind === 'too_many_attempts' ? 'too_many_attempts' : 'verification_failed' }
      }

      const user = await tx.user.findUnique({
        where: { id: pointer.userId },
        include: { pointAccount: true },
      })
      if (!user || !isActiveAdmin(user) || user.mfaEnabled || !lookup.challenge.secretEncrypted) {
        return { kind: 'challenge_invalid' }
      }

      let valid = false
      try {
        valid = verifyTotp(decryptMfaSecret(lookup.challenge.secretEncrypted), input.code)
      } catch {
        valid = false
      }
      if (!valid) {
        return { kind: await recordMfaFactorFailure({
          tx,
          userId: user.id,
          challengeId: lookup.challenge.id,
          purpose: 'admin_enroll',
          method: 'totp',
          ip: input.ip,
          userAgent: input.userAgent,
        }) }
      }

      if (!(await consumeAuthChallenge({
        challengeId: lookup.challenge.id,
        userId: user.id,
        purpose: 'admin_enroll',
        tx,
      }))) {
        return { kind: 'verification_failed' }
      }

      const now = new Date()
      // The same condition protects against sibling enrollment challenges or
      // an out-of-band state change. This transaction owns the user lock, and
      // a lost compare-and-set rolls back its consumed challenge.
      const enabled = await tx.user.updateMany({
        where: { id: user.id, role: 'admin', mfaEnabled: false },
        data: {
          mfaEnabled: true,
          mfaSecretEncrypted: lookup.challenge.secretEncrypted,
          mfaVerifiedAt: now,
          mfaVersion: { increment: 1 },
        },
      })
      if (enabled.count !== 1) throw new MfaChallengeChangedError()

      // A second password-login enrollment challenge can exist in another
      // browser tab. Once one seed wins, none of the siblings may overwrite
      // the enabled seed or replace this recovery-code set later.
      await tx.authChallenge.updateMany({
        where: {
          userId: user.id,
          purpose: 'admin_enroll',
          consumedAt: null,
        },
        data: { consumedAt: now },
      })

      const recoveryCodes = await replaceMfaRecoveryCodes(user.id, { tx })
      await revokeAllUserRefreshTokens(user.id, tx, 'mfa_migration', { ip: input.ip, userAgent: input.userAgent })
      const session = await createStoredRefreshToken(user.id, input.ip, input.userAgent, tx, maxAgeMs)
      const enrolled = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { pointAccount: true },
      })

      await recordSecurityEvent({
        type: 'mfa_enrolled',
        userId: user.id,
        sessionId: session.sessionId,
        ip: input.ip,
        userAgent: input.userAgent,
        detail: { method: 'totp', recoveryCodeCount: recoveryCodes.length },
      }, tx)
      await recordSecurityEvent({
        type: 'mfa_login_succeeded',
        userId: user.id,
        sessionId: session.sessionId,
        ip: input.ip,
        userAgent: input.userAgent,
        detail: { method: 'totp' },
      }, tx)

      return { kind: 'issued', user: enrolled, session, recoveryCodes }
    })
  } catch (err) {
    if (err instanceof MfaChallengeChangedError) throw mfaVerificationFailed()
    throw err
  }

  if (outcome.kind !== 'issued') return mapMfaVerificationOutcome(outcome)
  return issueMfaLoginResponse(outcome)
}

export async function verifyAdminMfaLogin(input: {
  challengeId: string
  method: 'totp' | 'recovery'
  code: string
  ip?: string
  userAgent?: string
}) {
  const pointer = await findMfaChallengeOwner(input.challengeId, 'admin_login')
  const maxAgeMs = await getRefreshTokenMaxAgeMs()

  let outcome: MfaVerificationOutcome
  try {
    outcome = await prisma.$transaction(async tx => {
      await lockUserRefreshSessionMutations(tx, pointer.userId)
      const lookup = await getUsableAuthChallenge({
        challengeId: input.challengeId,
        userId: pointer.userId,
        purpose: 'admin_login',
        tx,
      })
      if (lookup.kind !== 'active') {
        return { kind: lookup.kind === 'too_many_attempts' ? 'too_many_attempts' : 'verification_failed' }
      }

      const user = await tx.user.findUnique({
        where: { id: pointer.userId },
        include: { pointAccount: true },
      })
      if (!user || !isActiveAdmin(user) || !user.mfaEnabled || !user.mfaSecretEncrypted) {
        return { kind: 'challenge_invalid' }
      }

      const method: MfaFactorMethod = input.method === 'recovery' ? 'recovery_code' : 'totp'
      let valid = false
      if (input.method === 'totp') {
        try {
          valid = verifyTotp(decryptMfaSecret(user.mfaSecretEncrypted), input.code)
        } catch {
          valid = false
        }
      } else {
        valid = await claimMfaRecoveryCode(user.id, input.code, { tx })
      }

      if (!valid) {
        return { kind: await recordMfaFactorFailure({
          tx,
          userId: user.id,
          challengeId: lookup.challenge.id,
          purpose: 'admin_login',
          method,
          ip: input.ip,
          userAgent: input.userAgent,
        }) }
      }

      if (!(await consumeAuthChallenge({
        challengeId: lookup.challenge.id,
        userId: user.id,
        purpose: 'admin_login',
        tx,
      }))) {
        // For a recovery code, this exception rolls back its conditional
        // claim; the factor cannot be spent if the challenge lost a race.
        throw new MfaChallengeChangedError()
      }

      const session = await createStoredRefreshToken(user.id, input.ip, input.userAgent, tx, maxAgeMs)
      const recoveryCodeRemaining = input.method === 'recovery'
        ? await countUnusedMfaRecoveryCodes(user.id, tx)
        : undefined

      if (input.method === 'recovery') {
        await recordSecurityEvent({
          type: 'mfa_recovery_used',
          userId: user.id,
          sessionId: session.sessionId,
          ip: input.ip,
          userAgent: input.userAgent,
          detail: { remainingRecoveryCodes: recoveryCodeRemaining },
        }, tx)
      }
      await recordSecurityEvent({
        type: 'mfa_login_succeeded',
        userId: user.id,
        sessionId: session.sessionId,
        ip: input.ip,
        userAgent: input.userAgent,
        detail: { method },
      }, tx)

      return { kind: 'issued', user, session, recoveryCodeRemaining }
    })
  } catch (err) {
    if (err instanceof MfaChallengeChangedError) throw mfaVerificationFailed()
    throw err
  }

  if (outcome.kind !== 'issued') return mapMfaVerificationOutcome(outcome)
  return issueMfaLoginResponse(outcome)
}

export type BreakGlassMfaResetInput = {
  userId: number
  /** A bounded, approved operations ticket reference; never free-form text. */
  caseRef: string
}

/**
 * Offline recovery primitive for the two-person break-glass SOP. This is
 * intentionally service-only: no controller or HTTP route may call it. The
 * SecurityEvent serializer validates the case reference inside this same
 * transaction, so an invalid audit record rolls every credential mutation
 * back rather than leaving a partially reset administrator.
 */
export async function resetAdminMfaForBreakGlass(input: BreakGlassMfaResetInput) {
  if (!Number.isSafeInteger(input.userId) || input.userId < 1) {
    throw notFound('管理员不存在')
  }

  return prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, input.userId)
    const admin = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, role: true, mfaVersion: true },
    })
    if (!admin || admin.role !== 'admin') throw notFound('管理员不存在')

    const now = new Date()
    await tx.user.update({
      where: { id: admin.id },
      data: {
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaVerifiedAt: null,
        mfaVersion: { increment: 1 },
      },
    })
    await tx.mfaRecoveryCode.updateMany({
      where: { userId: admin.id, usedAt: null },
      data: { usedAt: now },
    })
    await tx.authChallenge.updateMany({
      where: { userId: admin.id, consumedAt: null },
      data: { consumedAt: now, secretEncrypted: null },
    })
    const revokedCount = await revokeAllUserRefreshTokens(
      admin.id,
      tx,
      'mfa_break_glass_reset',
    )
    await recordSecurityEvent({
      type: 'mfa_break_glass_reset',
      userId: admin.id,
      detail: { caseRef: input.caseRef, revokedCount },
    }, tx)

    return { revokedCount, mfaVersion: admin.mfaVersion + 1 }
  })
}
