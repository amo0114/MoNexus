import { accountStatus, isAccountBanned, legacyStatus } from '../accountGovernance/status.js'
import { merchantContext } from '../merchantGovernance/lifecycle.js'
import { PASSWORD_BCRYPT_ROUNDS } from './credentialPrimitives.js'
import {
  buildAuthUser,
  generateAccessToken,
  hashRefreshToken,
  createStoredRefreshToken,
} from './sessionIssuance.js'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { isPresetAvatarUrl } from './avatarPresets.js'
import { MediaRefResolutionError, resolveLegacyPlatformImageUrl } from '../catalog/platformMedia.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, sessionRevoked, sessionChanged, unauthenticated } from '../../lib/httpError.js'
import { getRefreshTokenMaxAgeMs } from '../../lib/systemConfig.js'
import {
  hasActiveRefreshSessionSuccessor,
  hasExplicitRefreshSessionTermination,
  lockUserRefreshSessionMutations,
  revokeAllUserRefreshTokens,
  revokeRefreshSessionByTokenHash,
  revokeSameUserRefreshCookieSession,
  type SessionRequestMetadata,
} from './sessionService.js'
import { computeSessionExpiry } from './sessionPolicy.js'
import { recordSecurityEvent } from './securityEvents.js'
import { createAuthChallenge } from './mfa.js'
import { clearLoginFailures, enforceLoginVerification, recordLoginFailure } from './loginFailures.js'
import type { HumanVerificationRequest } from './humanVerification.js'
import { resolveUserNickname } from '../../lib/defaultNickname.js'

type AuthenticatedLoginResult = {
  kind: 'authenticated'
  accessToken: string
  refreshToken: string
  refreshTokenExpiresAt: Date
  user: ReturnType<typeof buildAuthUser>
}

type MfaChallengeLoginResult = {
  kind: 'mfa_challenge'
  status: 'mfa_enrollment_required' | 'mfa_required'
  challengeId: string
  expiresAt: Date
}

export type LoginResult = AuthenticatedLoginResult | MfaChallengeLoginResult

// A cost-12 hash of a throwaway string: unknown emails pay the same bcrypt
// cost as real ones, so response time does not reveal account existence.
const LOGIN_TIMING_EQUALIZER_HASH = '$2a$12$4OvJg9qSMmfN1g2fOK6TpuB6VcfVC6uXm8CVJ1Q.A620ttoz2x6Ee'

export async function loginUser(
  email: string,
  password: string,
  ip?: string,
  userAgent?: string,
  humanVerification?: HumanVerificationRequest['humanVerification'],
  existingRefreshToken?: string,
): Promise<LoginResult> {
  // Checked before the account lookup so unknown emails behave identically.
  await enforceLoginVerification(email, humanVerification, ip)
  const credentialFailure = async () => {
    await recordLoginFailure(email)
    return unauthenticated('邮箱或密码错误')
  }

  // This non-decision lookup identifies the advisory-lock key only. The
  // password, status, role, and points are all re-read after taking the lock.
  const candidate = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (!candidate) {
    await bcrypt.compare(password, LOGIN_TIMING_EQUALIZER_HASH)
    throw await credentialFailure()
  }

  const maxAgeMs = await getRefreshTokenMaxAgeMs()
  const issued = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, candidate.id)
    const user = await tx.user.findUnique({
      where: { id: candidate.id },
      include: { pointAccount: true, merchant: true },
    })
    if (!user) throw await credentialFailure()

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) throw await credentialFailure()
    await clearLoginFailures(email)
    // Only someone who proved the password learns that the account is banned.
    if (await isAccountBanned(user.id, tx)) throw badRequest('账号已被封禁')

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

    const now = new Date()
    await revokeSameUserRefreshCookieSession(tx, {
      userId: user.id,
      tokenHash: existingRefreshToken ? hashRefreshToken(existingRefreshToken) : null,
      now,
      metadata: { ip, userAgent },
    })
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } })
    const session = await createStoredRefreshToken(
      user.id,
      ip,
      userAgent,
      tx,
      maxAgeMs,
      undefined,
      user.role,
      now,
    )
    return { kind: 'authenticated' as const, user, session }
  })

  if (issued.kind === 'mfa_challenge') return issued

  const accessToken = generateAccessToken(
    issued.user.id,
    issued.user.role,
    issued.session.sessionId,
    undefined,
    issued.session.expiresAt,
  )

  return {
    kind: 'authenticated',
    accessToken,
    refreshToken: issued.session.refreshToken,
    refreshTokenExpiresAt: issued.session.expiresAt,
    user: buildAuthUser({ ...issued.user, status: 'active' }, issued.user.pointAccount?.balance ?? 0),
  }
}

async function classifyRevokedRefreshToken(
  tx: Prisma.TransactionClient,
  token: { userId: number; sessionId: string; revokeReason: string | null; expiresAt: Date },
  now: Date,
): Promise<'expired' | 'revoked' | 'replay'> {
  if (token.expiresAt <= now) return 'expired'
  // An explicit terminal reason on the presented row is terminal. For a
  // rotated or legacy-null row, escalate to replay only while the family has
  // no terminal marker AND still has an unexpired active successor.
  if (token.revokeReason !== null && token.revokeReason !== 'refresh_rotation') return 'revoked'
  if (await hasExplicitRefreshSessionTermination(tx, token.userId, token.sessionId)) return 'revoked'
  if (!(await hasActiveRefreshSessionSuccessor(tx, token.userId, token.sessionId, now))) return 'revoked'
  return 'replay'
}

async function handleRefreshReplay(
  tx: Prisma.TransactionClient,
  token: { id: number; userId: number; sessionId: string },
  metadata: SessionRequestMetadata,
  now: Date,
) {
  // Reuse the same lock-held `now` from replay classification so a successor
  // that was active at classification time is always marked `refresh_replay`
  // rather than drifting across an expiry boundary into `expired`.
  const revokedCount = await revokeAllUserRefreshTokens(token.userId, tx, 'refresh_replay', metadata, now)
  // Explicitly verify a `refresh_replay` marker exists on this family so the
  // family revocation reason stays consistent with `session_replay_detected`.
  const hasReplayMarker = await tx.refreshToken.findFirst({
    where: {
      userId: token.userId,
      sessionId: token.sessionId,
      revoked: true,
      revokeReason: 'refresh_replay',
    },
    select: { id: true },
  })
  if (!hasReplayMarker) {
    await tx.refreshToken.updateMany({
      where: { id: token.id },
      data: { revoked: true, revokedAt: now, revokeReason: 'refresh_replay' },
    })
  }
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

async function handleRevokedRefreshToken(
  tx: Prisma.TransactionClient,
  token: { id: number; userId: number; sessionId: string; revokeReason: string | null; expiresAt: Date },
  metadata: SessionRequestMetadata,
  now: Date,
) {
  const classification = await classifyRevokedRefreshToken(tx, token, now)
  if (classification === 'expired') return { kind: 'expired' as const }
  if (classification === 'revoked') return { kind: 'revoked' as const }
  return handleRefreshReplay(tx, token, metadata, now)
}

export async function refreshAccessToken(
  rawRefreshToken: string,
  ip?: string,
  userAgent?: string,
  expectedSessionId?: string,
) {
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
    if (expectedSessionId && storedToken.sessionId !== expectedSessionId) {
      return { kind: 'session_changed' as const }
    }

    const now = new Date()
    if (storedToken.revoked) {
      return handleRevokedRefreshToken(tx, storedToken, metadata, now)
    }

    const nextExpiry = computeSessionExpiry({
      role: storedToken.user.role,
      configuredMaxAgeMs: maxAgeMs,
      now,
      existing: {
        sessionStartedAt: storedToken.sessionStartedAt,
        absoluteExpiresAt: storedToken.absoluteExpiresAt,
      },
    })

    if (storedToken.expiresAt <= now || nextExpiry.expired) {
      await tx.refreshToken.updateMany({
        where: { id: storedToken.id, revoked: false },
        data: { revoked: true, revokedAt: now, revokeReason: 'expired' },
      })
      return { kind: 'expired' as const }
    }

    if (await isAccountBanned(storedToken.user.id, tx)) return { kind: 'banned' as const }
    // Legacy/admin sessions created before MFA enrollment must never rotate
    // into a token that looks MFA-verified. Successful MFA issuance is the
    // only route that can create a usable admin refresh family.
    if (storedToken.user.role === 'admin' && !storedToken.user.mfaEnabled) {
      return { kind: 'admin_session_invalid' as const }
    }

    // CAS remains a defense against direct/out-of-band writers. Normal API
    // paths are already serialized by the user lock, but a failed CAS must
    // still classify the post-write state with the exact same state machine.
    const revoked = await tx.refreshToken.updateMany({
      where: {
        id: storedToken.id,
        tokenHash,
        revoked: false,
        expiresAt: { gt: now },
      },
      data: { revoked: true, revokedAt: now, revokeReason: 'refresh_rotation' },
    })

    if (revoked.count !== 1) {
      const afterCas = await tx.refreshToken.findUnique({ where: { id: storedToken.id } })
      if (!afterCas) return { kind: 'invalid' as const }
      const postCasNow = new Date()
      if (afterCas.revoked) {
        return handleRevokedRefreshToken(tx, afterCas, metadata, postCasNow)
      }
      if (
        afterCas.expiresAt <= postCasNow
        || (afterCas.absoluteExpiresAt !== null && afterCas.absoluteExpiresAt <= postCasNow)
      ) {
        await tx.refreshToken.updateMany({
          where: { id: afterCas.id, revoked: false },
          data: { revoked: true, revokedAt: postCasNow, revokeReason: 'expired' },
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
        absoluteExpiresAt: nextExpiry.absoluteExpiresAt,
      },
      storedToken.user.role,
      now,
    )
    return {
      kind: 'rotated' as const,
      userId: storedToken.userId,
      role: storedToken.user.role,
      refreshToken: next.refreshToken,
      refreshTokenExpiresAt: next.expiresAt,
      sessionId: next.sessionId,
      mfaVersion: storedToken.user.role === 'admin' ? storedToken.user.mfaVersion : undefined,
    }
  })

  if (result.kind === 'invalid') throw unauthenticated('Refresh Token 无效')
  if (result.kind === 'session_changed') throw sessionChanged()
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
      result.refreshTokenExpiresAt,
    ),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt,
  }
}

export async function revokeRefreshToken(
  rawRefreshToken: string,
  ip?: string,
  userAgent?: string,
  expectedSessionId?: string,
) {
  const tokenHash = hashRefreshToken(rawRefreshToken)
  await revokeRefreshSessionByTokenHash({
    tokenHash,
    expectedSessionId,
    metadata: { ip, userAgent },
  })
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
    status: legacyStatus(await accountStatus(userId)),
    accountStatus: await accountStatus(userId),
    ...await merchantContext(userId),
    nickname: resolveUserNickname(user),
    avatarUrl: user.avatarUrl ?? null,
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

export async function updateUserProfile(userId: number, data: { nickname?: string; avatarUrl?: string | null }) {
  const update: { nickname?: string; nicknameIsGenerated?: boolean; avatarUrl?: string | null } = {}
  if (data.nickname !== undefined) {
    // 服务端二次校验:1-20 字,禁止控制字符。
    const normalized = data.nickname.trim()
    if (!normalized || normalized.length > 20 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw badRequest('昵称需为 1-20 个字符')
    }
    update.nickname = normalized
    update.nicknameIsGenerated = false
  }
  if (data.avatarUrl !== undefined) {
    // 头像仅限已发布预设，或本平台登记过的公开上传图片（按对象自身的存储配置
    // 生成规范 URL 并精确比对 origin+path）。前缀匹配会放过
    // `https://cdn.example.com.evil.net/…` 之类的外部地址，造成查看者被外部追踪。
    if (data.avatarUrl !== null && !isPresetAvatarUrl(data.avatarUrl)) {
      const resolved = await resolveLegacyPlatformImageUrl(data.avatarUrl).catch((err: unknown) => {
        if (err instanceof MediaRefResolutionError) return null
        throw err
      })
      if (resolved?.source !== 'upload_image') throw badRequest('请选择预设头像或使用平台上传的图片')
      update.avatarUrl = resolved.canonicalUrl
    } else {
      update.avatarUrl = data.avatarUrl
    }
  }
  if (Object.keys(update).length === 0) throw badRequest('没有可更新的字段')
  await prisma.user.update({ where: { id: userId }, data: update })
  return getUserProfile(userId)
}

export {
  startAdminMfaEnrollment,
  confirmAdminMfaEnrollment,
  verifyAdminMfaLogin,
  resetAdminMfaForBreakGlass,
  type BreakGlassMfaResetInput,
} from './mfaService.js'

export { revokeAllUserRefreshTokens } from './sessionService.js'

export { PASSWORD_BCRYPT_ROUNDS } from './credentialPrimitives.js'
export { requestPasswordReset, resetPasswordWithToken, changePassword } from './passwordService.js'
export { sendEmailVerification, verifyEmailWithToken } from './emailVerificationService.js'

export {
  isRegistrationEnabled,
  assertRegistrationEnabled,
  isInviteOnlyRegistration,
  getPublicRegistrationStatus,
  registerUser,
} from './registrationService.js'
export { issueHumanChallenge } from './authProtection.js'
