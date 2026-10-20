import { PASSWORD_BCRYPT_ROUNDS } from './credentialPrimitives.js'
import {
  buildAuthUser,
  generateAccessToken,
  hashRefreshToken,
  createStoredRefreshToken,
} from './sessionIssuance.js'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { isPresetAvatarUrl } from './avatarPresets.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, sessionRevoked, sessionChanged, unauthenticated } from '../../lib/httpError.js'
import { getRefreshTokenMaxAgeMs } from '../../lib/systemConfig.js'
import {
  hasExplicitRefreshSessionTermination,
  lockUserRefreshSessionMutations,
  revokeAllUserRefreshTokens,
  revokeRefreshSessionByTokenHash,
  type SessionRequestMetadata,
} from './sessionService.js'
import { recordSecurityEvent } from './securityEvents.js'
import { createAuthChallenge } from './mfa.js'
import { resolveUserNickname } from '../../lib/defaultNickname.js'

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
    ),
    refreshToken: result.refreshToken,
    refreshTokenMaxAgeMs: maxAgeMs,
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
    status: user.status,
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
    // 头像仅限已发布预设的精确路径或平台图床上传地址。
    // - S3 模式:URL 必须以配置的 STORAGE_PUBLIC_URL_BASE 为前缀;
    // - 内存/开发模式:URL 的路径必须以 /uploads/ 开头(本平台上传路径)。
    // 禁止任意外部 URL,防止外部图片追踪与隐私泄露。
    if (data.avatarUrl !== null && !isPresetAvatarUrl(data.avatarUrl)) {
      let allowed = false
      if (config.storage.kind === 's3' && config.storage.publicUrlBase) {
        allowed = data.avatarUrl.startsWith(config.storage.publicUrlBase.replace(/\/$/, ''))
      } else {
        try {
          const u = new URL(data.avatarUrl)
          allowed = u.pathname.startsWith('/uploads/')
        } catch {
          allowed = false
        }
      }
      if (!allowed) throw badRequest('请选择预设头像或使用平台上传的图片')
    }
    update.avatarUrl = data.avatarUrl
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
