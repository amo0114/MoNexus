import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import {
  abuseProtectionUnavailable,
  badRequest,
  conflict,
  humanVerificationFailed,
  humanVerificationRequired,
  humanVerificationUnavailable,
  mfaChallengeInvalid,
  mfaTooManyAttempts,
  mfaVerificationFailed,
  notFound,
  registrationDisabled,
  sessionRevoked,
  tooManyRequests,
  unauthenticated,
} from '../../lib/httpError.js'
import {
  consumePasswordReset,
  consumeRegistrationAttempt,
  consumeRegistrationProviderPreflight,
  consumeVerificationEmailSend,
} from './abusePolicy.js'
import { getHumanVerifier } from './humanVerification.js'
import { getMailer } from '../../lib/mailer/index.js'
import { renderMail } from '../../lib/mailer/templates/index.js'
import { normalizeInviteCode } from '../../lib/inviteCode.js'
import { claimInviteCodeForRegistration } from '../invite/service.js'
import { getRefreshTokenMaxAgeMs, getSystemConfigValue } from '../../lib/systemConfig.js'
import {
  createRefreshTokenRecord,
  hasExplicitRefreshSessionTermination,
  lockUserRefreshSessionMutations,
  revokeRefreshSessionByTokenHash,
  type SessionRequestMetadata,
} from './sessionService.js'
import { recordSecurityEvent, type SessionRevocationReason } from './securityEvents.js'
import { recordAbuseEvent } from './abuseEvents.js'
import {
  getLegalRequirement,
  recordUserConsents,
  resolveConsentEvidence,
} from '../legal/service.js'
import {
  createClaimedReferralGrowthReward,
  createRegistrationGrowthReward,
  holdGrowthRewardsAfterEmailVerification,
} from './growthRewards.js'
import {
  claimMfaRecoveryCode,
  consumeAuthChallenge,
  countUnusedMfaRecoveryCodes,
  createAuthChallenge,
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

export const PASSWORD_BCRYPT_ROUNDS = 12

type MfaSessionClaims = {
  verified: true
  version: number
}

type AuthenticatedLoginResult = {
  kind: 'authenticated'
  accessToken: string
  refreshToken: string
  refreshTokenMaxAgeMs: number
  user: ReturnType<typeof buildAuthUser>
}

type MfaChallengeLoginResult = {
  kind: 'mfa_challenge'
  status: 'mfa_enrollment_required' | 'mfa_required'
  challengeId: string
  expiresAt: Date
}

export type LoginResult = AuthenticatedLoginResult | MfaChallengeLoginResult

function generateAccessToken(userId: number, role: string, sessionId: string, mfa?: MfaSessionClaims) {
  return jwt.sign({
    userId,
    role,
    sid: sessionId,
    ...(role === 'admin' && mfa ? { mfaVerified: true, mfaVersion: mfa.version } : {}),
  }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex')
}

function hashRefreshToken(refreshToken: string) {
  return crypto.createHash('sha256').update(refreshToken).digest('hex')
}

function buildAuthUser(user: { id: number; email: string; role: string; status: string; nickname: string | null }, points = 0) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    nickname: user.nickname,
    points,
  }
}

async function createStoredRefreshToken(
  userId: number,
  ip: string | undefined,
  userAgent: string | undefined,
  tx: Prisma.TransactionClient,
  configuredMaxAgeMs: number,
  existingSession?: { sessionId: string; sessionStartedAt: Date },
) {
  const refreshToken = generateRefreshToken()
  const now = new Date()
  const stored = await createRefreshTokenRecord({
    userId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(now.getTime() + configuredMaxAgeMs),
    ip,
    userAgent,
    ...(existingSession === undefined
      ? {}
      : {
          sessionId: existingSession.sessionId,
          sessionStartedAt: existingSession.sessionStartedAt,
          lastUsedAt: now,
        }),
  }, tx)
  return { refreshToken, maxAgeMs: configuredMaxAgeMs, sessionId: stored.sessionId }
}

/**
 * REG-01 / C2：开关判定的唯一定义。fail-closed——只有恰好为 1 才算开启，
 * 被手工写坏的值（例如 2）一律按关闭处理；缺记录时 `getSystemConfigValue`
 * 回落默认 1，保证升级站点默认仍开放注册。
 *
 * 刻意不缓存：REG-05 要求"改开关成功之后开始处理的请求必须读到新值"，
 * 一次主键读换取即时性。
 */
export async function isRegistrationEnabled(): Promise<boolean> {
  return (await getSystemConfigValue('registrationEnabled')) === 1
}

/**
 * REG-03/REG-04 的强制边界。放在 service 而不是 controller/路由，是为了让
 * 未来的 CLI、内部调用共享同一道门；删路由式的"关闭"做不到这点，也留不下
 * 运营审计记录。
 */
export async function assertRegistrationEnabled() {
  if (!(await isRegistrationEnabled())) throw registrationDisabled()
}

function normalizeEmailAddress(email: string) {
  return email.trim().toLowerCase()
}

function registrationProtectionIsEnforced() {
  return config.abuseProtectionMode === 'enforce'
}

async function consumeAbuseBucket(
  consume: () => Promise<{ allowed: boolean; retryAfterSeconds: number }>,
) {
  let result: { allowed: boolean; retryAfterSeconds: number }
  try {
    result = await consume()
  } catch {
    // Never let a Redis client/timeout/circuit error reach the generic error
    // handler with provider/client details. Security callers fail closed.
    throw abuseProtectionUnavailable()
  }
  if (!result.allowed) {
    // Expose only the safe, rounded delay. The shared error layer emits it as
    // `Retry-After` without revealing the hit dimension or any identifier.
    throw tooManyRequests(undefined, result.retryAfterSeconds)
  }
}

async function enforceRegistrationProtection(input: {
  email: string
  ip?: string
  turnstileToken?: string
}) {
  if (!registrationProtectionIsEnforced()) return

  // This is deliberately the first side effect after the registration gate:
  // a provider flood must be stopped before Turnstile or any password/DB work.
  await consumeAbuseBucket(() => consumeRegistrationProviderPreflight(input.ip ?? ''))

  const token = typeof input.turnstileToken === 'string' ? input.turnstileToken.trim() : ''
  if (!token) throw humanVerificationRequired()
  if (token.length > 4_096) throw humanVerificationFailed()

  let verification: Awaited<ReturnType<ReturnType<typeof getHumanVerifier>['verify']>>
  try {
    verification = await getHumanVerifier().verify({ token, ip: input.ip, action: 'register' })
  } catch {
    throw humanVerificationUnavailable()
  }
  if (verification.kind === 'unavailable') throw humanVerificationUnavailable()
  if (verification.kind === 'rejected') throw humanVerificationFailed()

  // Turnstile has established a human proof; only now consume the expensive
  // registration attempt buckets, immediately before bcrypt and DB work.
  await consumeAbuseBucket(() => consumeRegistrationAttempt({
    ip: input.ip ?? '',
    email: input.email,
  }))
}

/**
 * SPEC-INVITE-001 IV-08：invite-only 开关，读法与 registrationEnabled 同款
 * fail-closed（恰为 1 才算开启）且刻意不缓存。
 */
export async function isInviteOnlyRegistration(): Promise<boolean> {
  return (await getSystemConfigValue('registrationInviteOnly')) === 1
}

/**
 * Public status intentionally reports only a safe browser challenge
 * descriptor. Redis health is deliberately not probed here: the actual
 * registration path remains fail-closed if a runtime command is unavailable.
 */
export async function getPublicRegistrationStatus() {
  const [registrationEnabled, inviteRequired] = await Promise.all([
    isRegistrationEnabled(),
    isInviteOnlyRegistration(),
  ])

  // SPEC-LEGAL-001：注册勾选项的协议要求（页面关闭 = null，前端隐藏勾选区）。
  const legalRequirement = getLegalRequirement('registration')

  if (!registrationProtectionIsEnforced()) {
    return {
      registrationEnabled,
      registrationAvailable: registrationEnabled,
      inviteRequired,
      challenge: null,
      legalRequirement,
    }
  }

  const configured = Boolean(
    config.redisEnabled
    && config.redisRequired
    && config.abuseHashKey
    && config.turnstile.siteKey
    && config.turnstile.secretKey
    && config.turnstile.allowedHostnames.length > 0,
  )
  if (!configured) {
    return {
      registrationEnabled,
      registrationAvailable: false,
      inviteRequired,
      challenge: null,
      legalRequirement,
    }
  }

  return {
    registrationEnabled,
    registrationAvailable: registrationEnabled,
    inviteRequired,
    challenge: {
      provider: 'turnstile' as const,
      siteKey: config.turnstile.siteKey,
    },
    legalRequirement,
  }
}

export async function registerUser(
  email: string,
  password: string,
  inviteCode?: string,
  ip?: string,
  userAgent?: string,
  turnstileToken?: string,
  agreements?: Record<string, string>,
) {
  // REG-03：必须是第一步——查重、bcrypt、建号事务都在其后，关闭态下不会
  // 产生任何可观测副作用（连"该邮箱已注册"这种探测口子也不给）。
  await assertRegistrationEnabled()

  const normalizedEmail = normalizeEmailAddress(email)
  await enforceRegistrationProtection({
    email: normalizedEmail,
    ip,
    turnstileToken,
  })

  // SPEC-LEGAL-001：协议证据解析在任何 DB 写入之前（纯注册表比对，零副作用）。
  // enforce 下缺/旧版本在此拒绝，不会产生半截账号。
  const consentEvidence = resolveConsentEvidence('registration', agreements)

  // IV-08：invite-only 检查位于注册开关与滥用防护之后、查邮箱重复之前。
  // HTTP 侧 schema 已归一化；这里对直接调用方（CLI/测试）重跑同一归一化。
  const hasInviteCodeInput = typeof inviteCode === 'string' && inviteCode.trim() !== ''
  const claimCode = hasInviteCodeInput ? normalizeInviteCode(inviteCode) : null
  if (hasInviteCodeInput && claimCode === null) throw badRequest('邀请码格式不正确')
  if (!claimCode && (await isInviteOnlyRegistration())) {
    throw badRequest('当前仅限邀请注册')
  }

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
  if (existing) throw conflict('该邮箱已注册')

  const hashedPassword = await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS)

  const result = await prisma.$transaction(async tx => {
    const registerReward = await getSystemConfigValue('registerReward', tx)

    const newUser = await tx.user.create({
      data: { email: normalizedEmail, password: hashedPassword },
    })

    await tx.pointAccount.create({
      data: { userId: newUser.id, balance: 0 },
    })

    await createRegistrationGrowthReward(tx, newUser.id, registerReward)

    // SPEC-LEGAL-001：同意证据与账号同事务——账号在则证据在，绝不出现
    // "已注册但未留证"的用户。IP/UA 由 retention cron 到期匿名化。
    await recordUserConsents(tx, {
      userId: newUser.id,
      evidences: consentEvidence,
      ip,
      userAgent,
    })

    if (claimCode) {
      // IV-03/IV-07/IV-09：一次性码在本事务内原子领用，任何失败都显式 400
      // 并回滚整个注册；领用成功即建 pending 关系 + 冻结 referral 奖励。
      // 锁序：新用户 User 行（create 自带）→ InviteCode 行 → issuer User 行。
      const claimed = await claimInviteCodeForRegistration(tx, {
        code: claimCode,
        usedByUserId: newUser.id,
      })
      await createClaimedReferralGrowthReward(tx, {
        inviterId: claimed.issuerId,
        inviteeId: newUser.id,
      })
    }

    return { user: newUser }
  })

  // Read the runtime setting before taking the per-user lock. No global Prisma
  // call is allowed while the transaction owns that lock.
  const maxAgeMs = await getRefreshTokenMaxAgeMs()
  const issued = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, result.user.id)
    const currentUser = await tx.user.findUnique({ where: { id: result.user.id } })
    if (!currentUser) throw notFound('用户不存在')
    if (currentUser.status === '已封禁') throw badRequest('账号已被封禁')

    const session = await createStoredRefreshToken(currentUser.id, ip, userAgent, tx, maxAgeMs)
    return { user: currentUser, session }
  })
  const accessToken = generateAccessToken(issued.user.id, issued.user.role, issued.session.sessionId)

  return {
    accessToken,
    refreshToken: issued.session.refreshToken,
    refreshTokenMaxAgeMs: issued.session.maxAgeMs,
    // Registration awards are only ledger rows at this point. Returning the
    // configured amount here would make clients advertise spendable points
    // that do not exist yet.
    user: buildAuthUser(issued.user, 0),
  }
}

export async function loginUser(email: string, password: string, ip?: string, userAgent?: string): Promise<LoginResult> {
  // This non-decision lookup identifies the advisory-lock key only. The
  // password, status, role, and points are all re-read after taking the lock.
  const candidate = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (!candidate) throw unauthenticated('邮箱或密码错误')

  const maxAgeMs = await getRefreshTokenMaxAgeMs()
  const issued = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, candidate.id)
    const user = await tx.user.findUnique({
      where: { id: candidate.id },
      include: { pointAccount: true },
    })
    if (!user) throw unauthenticated('邮箱或密码错误')
    if (user.status === '已封禁') throw badRequest('账号已被封禁')

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) throw unauthenticated('邮箱或密码错误')

    // An administrator's password is only pre-authentication. Do not retain
    // it, rehash it, or create a refresh family until a factor succeeds.
    if (user.role === 'admin') {
      const challenge = await createAuthChallenge({
        userId: user.id,
        purpose: user.mfaEnabled ? 'admin_login' : 'admin_enroll',
        tx,
      })
      return {
        kind: 'mfa_challenge' as const,
        status: user.mfaEnabled ? 'mfa_required' as const : 'mfa_enrollment_required' as const,
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt,
      }
    }

    // A successful, non-admin password login is the only opportunistic
    // migration point for legacy bcrypt hashes. The user lock makes the
    // verification and replacement one coherent credential transition.
    if (bcrypt.getRounds(user.password) < PASSWORD_BCRYPT_ROUNDS) {
      await tx.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS) },
      })
    }

    const session = await createStoredRefreshToken(user.id, ip, userAgent, tx, maxAgeMs)
    return { kind: 'authenticated' as const, user, session }
  })

  if (issued.kind === 'mfa_challenge') return issued

  const accessToken = generateAccessToken(issued.user.id, issued.user.role, issued.session.sessionId)

  return {
    kind: 'authenticated',
    accessToken,
    refreshToken: issued.session.refreshToken,
    refreshTokenMaxAgeMs: issued.session.maxAgeMs,
    user: buildAuthUser(issued.user, issued.user.pointAccount?.balance ?? 0),
  }
}

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


async function shouldTreatRevokedRefreshTokenAsReplay(
  tx: Prisma.TransactionClient,
  token: { userId: number; sessionId: string; revokeReason: string | null },
) {
  // An explicit reason on the presented row is terminal. For a historical
  // rotation/null row, inspect the whole family because its active successor
  // may have been explicitly revoked after the rotation.
  if (token.revokeReason !== null && token.revokeReason !== 'refresh_rotation') return false
  return !(await hasExplicitRefreshSessionTermination(tx, token.userId, token.sessionId))
}

async function handleRefreshReplay(
  tx: Prisma.TransactionClient,
  token: { userId: number; sessionId: string },
  metadata: SessionRequestMetadata,
) {
  const revokedCount = await revokeAllUserRefreshTokens(token.userId, tx, 'refresh_replay', metadata)
  await recordSecurityEvent({
    type: 'session_replay_detected',
    userId: token.userId,
    sessionId: token.sessionId,
    ip: metadata.ip,
    userAgent: metadata.userAgent,
    detail: { action: 'revoke_all_user_sessions', revokedCount },
  }, tx)
  return { kind: 'reused' as const }
}

export async function refreshAccessToken(rawRefreshToken: string, ip?: string, userAgent?: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken)
  // This lookup discovers the only safe advisory-lock key. It does not decide
  // whether the token is active, replayed, expired, or allowed to rotate.
  const pointer = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { userId: true } })
  if (!pointer) throw unauthenticated('Refresh Token 无效')

  // Read once before taking the session lock so the winning DB row and cookie
  // share one runtime setting without doing a global Prisma read under lock.
  const maxAgeMs = await getRefreshTokenMaxAgeMs()
  const metadata: SessionRequestMetadata = { ip, userAgent }

  const result = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, pointer.userId)

    // Mandatory post-lock re-read closes both the explicit-revoke and
    // competing-rotation windows.
    const storedToken = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    })
    if (!storedToken) return { kind: 'invalid' as const }

    if (storedToken.revoked) {
      if (!(await shouldTreatRevokedRefreshTokenAsReplay(tx, storedToken))) {
        return { kind: 'revoked' as const }
      }
      return handleRefreshReplay(tx, storedToken, metadata)
    }

    const now = new Date()
    if (storedToken.expiresAt < now) {
      await tx.refreshToken.updateMany({
        where: { id: storedToken.id, revoked: false },
        data: { revoked: true, revokedAt: now, revokeReason: 'expired' },
      })
      return { kind: 'expired' as const }
    }

    if (storedToken.user.status === '已封禁') return { kind: 'banned' as const }
    // Legacy/admin sessions created before MFA enrollment must never rotate
    // into a token that looks MFA-verified. Successful MFA issuance is the
    // only route that can create a usable admin refresh family.
    if (storedToken.user.role === 'admin' && !storedToken.user.mfaEnabled) {
      return { kind: 'admin_session_invalid' as const }
    }

    // CAS remains a defense against direct/out-of-band writers. Normal API
    // paths are already serialized by the user lock, but a failed CAS must
    // still classify the post-write state instead of assuming replay.
    const revoked = await tx.refreshToken.updateMany({
      where: {
        id: storedToken.id,
        tokenHash,
        revoked: false,
        expiresAt: { gte: now },
      },
      data: { revoked: true, revokedAt: now, revokeReason: 'refresh_rotation' },
    })

    if (revoked.count !== 1) {
      const afterCas = await tx.refreshToken.findUnique({ where: { id: storedToken.id } })
      if (!afterCas) return { kind: 'invalid' as const }
      if (afterCas.revoked) {
        if (!(await shouldTreatRevokedRefreshTokenAsReplay(tx, afterCas))) {
          return { kind: 'revoked' as const }
        }
        return handleRefreshReplay(tx, afterCas, metadata)
      }
      if (afterCas.expiresAt < new Date()) {
        await tx.refreshToken.updateMany({
          where: { id: afterCas.id, revoked: false, expiresAt: { lt: new Date() } },
          data: { revoked: true, revokedAt: new Date(), revokeReason: 'expired' },
        })
        return { kind: 'expired' as const }
      }
      return { kind: 'invalid' as const }
    }

    const next = await createStoredRefreshToken(
      storedToken.userId,
      ip,
      userAgent,
      tx,
      maxAgeMs,
      {
        sessionId: storedToken.sessionId,
        sessionStartedAt: storedToken.sessionStartedAt,
      },
    )
    return {
      kind: 'rotated' as const,
      userId: storedToken.userId,
      role: storedToken.user.role,
      refreshToken: next.refreshToken,
      sessionId: next.sessionId,
      mfaVersion: storedToken.user.role === 'admin' ? storedToken.user.mfaVersion : undefined,
    }
  })

  if (result.kind === 'invalid') throw unauthenticated('Refresh Token 无效')
  if (result.kind === 'reused') throw unauthenticated('Refresh Token 已被使用，请重新登录')
  if (result.kind === 'revoked') throw unauthenticated('Refresh Token 已失效，请重新登录')
  if (result.kind === 'expired') throw unauthenticated('Refresh Token 已过期')
  if (result.kind === 'banned') throw badRequest('账号已被封禁')
  if (result.kind === 'admin_session_invalid') throw sessionRevoked()

  return {
    accessToken: generateAccessToken(
      result.userId,
      result.role,
      result.sessionId,
      result.role === 'admin' && typeof result.mfaVersion === 'number'
        ? { verified: true, version: result.mfaVersion }
        : undefined,
    ),
    refreshToken: result.refreshToken,
    refreshTokenMaxAgeMs: maxAgeMs,
  }
}

export async function revokeRefreshToken(rawRefreshToken: string, ip?: string, userAgent?: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken)
  await revokeRefreshSessionByTokenHash({ tokenHash, metadata: { ip, userAgent } })
}

export async function revokeAllUserRefreshTokens(
  userId: number,
  tx?: Prisma.TransactionClient,
  revokeReason: SessionRevocationReason = 'revoke_all',
  metadata: SessionRequestMetadata = {},
) {
  const revokeInTransaction = async (transaction: Prisma.TransactionClient) => {
    await lockUserRefreshSessionMutations(transaction, userId)
    const activeFamilies = await transaction.refreshToken.findMany({
      where: { userId, revoked: false },
      distinct: ['sessionId'],
      select: { sessionId: true },
    })
    const result = await transaction.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true, revokedAt: new Date(), revokeReason },
    })
    if (result.count > 0) {
      await recordSecurityEvent({
        type: 'session_revoked',
        userId,
        ip: metadata.ip,
        userAgent: metadata.userAgent,
        detail: { reason: revokeReason, revokedCount: activeFamilies.length },
      }, transaction)
    }
    return result.count
  }

  if (tx) return revokeInTransaction(tx)
  return prisma.$transaction(revokeInTransaction)
}

export async function getUserProfile(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { pointAccount: true, merchant: true },
  })
  if (!user) throw notFound('用户不存在')

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    nickname: user.nickname,
    points: user.pointAccount?.balance ?? 0,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    merchant: user.merchant
      ? {
          id: user.merchant.id,
          name: user.merchant.name,
          status: user.merchant.status,
          commissionRate: user.merchant.commissionRate.toString(),
        }
      : null,
  }
}

export async function updateUserProfile(userId: number, data: { nickname: string }) {
  await prisma.user.update({ where: { id: userId }, data: { nickname: data.nickname } })
  return getUserProfile(userId)
}

// ============================================================
// Password reset + email verification (P0-D)
// ============================================================

function hashAuthToken(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function generateAuthToken() {
  return crypto.randomBytes(32).toString('hex')
}

async function enforcePasswordResetProtection(email: string, ip?: string) {
  if (!registrationProtectionIsEnforced()) return
  await consumeAbuseBucket(() => consumePasswordReset({
    email: normalizeEmailAddress(email),
    ip: ip ?? '',
  }))
}

export async function requestPasswordReset(email: string, ip?: string) {
  const normalizedEmail = normalizeEmailAddress(email)
  // The policy is consumed before the account lookup. Unknown addresses pay
  // the same email/IP cost as known ones, while the controller preserves the
  // endpoint's generic 200 response for every outcome.
  await enforcePasswordResetProtection(normalizedEmail, ip)

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } })
  // Silently no-op for unknown emails so the public endpoint can return
  // the same 200 response regardless of existence (no enumeration).
  if (!user) return
  if (user.status === '已封禁') return

  const rawToken = generateAuthToken()
  await prisma.$transaction(async tx => {
    // A reset link is a single active credential. Issuing a new one invalidates
    // every earlier unused link for the account.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    })
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashAuthToken(rawToken),
        expiresAt: new Date(Date.now() + config.passwordResetTokenMaxAgeMs),
      },
    })
  })

  const mailer = await getMailer()
  const link = `${config.appBaseUrl}/reset-password/${rawToken}`
  await mailer.send(
    renderMail('password_reset', {
      to: user.email,
      resetUrl: link,
      expiresMinutes: 30,
    }),
  )
}

/**
 * A password mutation invalidates more than refresh sessions. An administrator
 * may have completed the password half of an MFA login just before the
 * mutation, so every still-pending pre-auth challenge must become unusable in
 * the same user-locked transaction. Advancing the version also invalidates
 * any administrator access token that survives outside a session check.
 */
async function applySuccessfulPasswordChange(
  tx: Prisma.TransactionClient,
  user: { id: number; role: string },
  passwordHash: string,
) {
  const now = new Date()
  await tx.user.update({
    where: { id: user.id },
    data: {
      password: passwordHash,
      ...(user.role === 'admin' ? { mfaVersion: { increment: 1 } } : {}),
    },
  })
  await tx.authChallenge.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: now },
  })
}

export async function resetPasswordWithToken(rawToken: string, newPassword: string) {
  const tokenHash = hashAuthToken(rawToken)
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  })
  if (!stored) throw badRequest('重置链接无效', 'BAD_REQUEST')
  if (stored.used) throw badRequest('重置链接已被使用', 'BAD_REQUEST')
  if (stored.expiresAt < new Date()) throw badRequest('重置链接已过期', 'BAD_REQUEST')

  const hashed = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS)
  const consumed = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, stored.userId)
    // Claim the credential atomically. The initial checks above are only used
    // to return helpful errors; this condition is what prevents two parallel
    // requests from both changing the password.
    const claim = await tx.passwordResetToken.updateMany({
      where: {
        id: stored.id,
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
      data: { used: true },
    })
    if (claim.count !== 1) return false

    const user = await tx.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, role: true },
    })
    if (!user) throw notFound('用户不存在')
    await applySuccessfulPasswordChange(tx, user, hashed)
    // A successful reset must invalidate any other link that was issued at
    // roughly the same time.
    await tx.passwordResetToken.updateMany({
      where: { userId: stored.userId, id: { not: stored.id }, used: false },
      data: { used: true },
    })
    // Revoke every refresh token outstanding for this user — if the
    // password is being reset, assume the prior session is compromised.
    await revokeAllUserRefreshTokens(stored.userId, tx)
    return true
  })

  if (!consumed) throw badRequest('重置链接已被使用或已过期', 'BAD_REQUEST')
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string) {
  const hashed = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS)
  await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, userId)
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw notFound('用户不存在')
    if (user.status === '已封禁') throw badRequest('账号已被封禁')

    const valid = await bcrypt.compare(currentPassword, user.password)
    if (!valid) throw unauthenticated('当前密码错误')

    await applySuccessfulPasswordChange(tx, user, hashed)
    await tx.passwordResetToken.updateMany({
      where: { userId, used: false },
      data: { used: true },
    })
    await revokeAllUserRefreshTokens(userId, tx)
  })
}

export async function sendEmailVerification(userId: number, ip?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw notFound('用户不存在')
  if (user.emailVerified) throw badRequest('邮箱已验证')

  if (registrationProtectionIsEnforced()) {
    await consumeAbuseBucket(() => consumeVerificationEmailSend({
      userId: user.id,
      email: user.email,
      ip: ip ?? '',
    }))
  }

  const rawToken = generateAuthToken()
  const issued = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, userId)
    const currentUser = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true, status: true },
    })
    if (!currentUser) throw notFound('用户不存在')
    if (currentUser.status === '已封禁') throw badRequest('账号已被封禁')
    if (currentUser.emailVerified) return null

    // One active verification credential per account. The user lock makes
    // concurrent resend requests serialize before this invalidation/create
    // pair, so a stale link cannot remain usable after a newer send wins.
    await tx.emailVerificationToken.updateMany({
      where: { userId: currentUser.id, used: false },
      data: { used: true },
    })
    await tx.emailVerificationToken.create({
      data: {
        userId: currentUser.id,
        tokenHash: hashAuthToken(rawToken),
        expiresAt: new Date(Date.now() + config.emailVerificationTokenMaxAgeMs),
      },
    })
    return { email: currentUser.email }
  })

  if (!issued) throw badRequest('邮箱已验证')

  const mailer = await getMailer()
  const link = `${config.appBaseUrl}/verify-email#token=${rawToken}`
  await mailer.send(
    renderMail('email_verification', {
      to: issued.email,
      verifyUrl: link,
      expiresHours: 24,
    }),
  )
}

export async function verifyEmailWithToken(userId: number, rawToken: string) {
  if (typeof rawToken !== 'string' || rawToken.length === 0 || rawToken.length > 4_096) {
    throw badRequest('验证链接无效或已过期', 'BAD_REQUEST')
  }
  const tokenHash = hashAuthToken(rawToken)
  const claimed = await prisma.$transaction(async tx => {
    // Serialize verification with resend and other account credential
    // transitions. The token update itself remains the atomic owner/expiry
    // claim, so a cross-account or concurrent request changes no state.
    await lockUserRefreshSessionMutations(tx, userId)
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, emailVerified: true, status: true },
    })
    if (!user || user.status === '已封禁' || user.emailVerified) return false

    const claim = await tx.emailVerificationToken.updateMany({
      where: {
        tokenHash,
        userId,
        used: false,
        expiresAt: { gt: new Date() },
      },
      data: { used: true },
    })
    if (claim.count !== 1) return false

    const verifiedAt = new Date()
    await tx.user.update({
      where: { id: userId },
      data: { emailVerified: verifiedAt },
    })
    await holdGrowthRewardsAfterEmailVerification(tx, { userId, verifiedAt })
    await recordAbuseEvent({
      type: 'email_verification_succeeded',
      userId,
    }, tx)
    return true
  })

  if (!claimed) throw badRequest('验证链接无效或已过期', 'BAD_REQUEST')
}
