import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, notFound, unauthenticated } from '../../lib/httpError.js'
import { getMailer } from '../../lib/mailer/index.js'
import { getRefreshTokenMaxAgeMs, getSystemConfigValue } from '../../lib/systemConfig.js'
import { applyTierBonus, getCurrentTierConfig, resolveTier } from '../../lib/memberTier.js'
import {
  createRefreshTokenRecord,
  hasExplicitRefreshSessionTermination,
  lockUserRefreshSessionMutations,
  revokeRefreshSessionByTokenHash,
  type SessionRequestMetadata,
} from './sessionService.js'
import { recordSecurityEvent, type SessionRevocationReason } from './securityEvents.js'

function generateAccessToken(userId: number, role: string, sessionId: string) {
  return jwt.sign({ userId, role, sid: sessionId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex')
}

function hashRefreshToken(refreshToken: string) {
  return crypto.createHash('sha256').update(refreshToken).digest('hex')
}

function buildAuthUser(user: { id: number; email: string; role: string; inviteCode: string; status: string; nickname: string | null }, points = 0) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    inviteCode: user.inviteCode,
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

export async function registerUser(email: string, password: string, inviteCode?: string, ip?: string, userAgent?: string) {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) throw conflict('该邮箱已注册')

  const hashedPassword = await bcrypt.hash(password, 10)

  const result = await prisma.$transaction(async tx => {
    const registerReward = await getSystemConfigValue('registerReward', tx)
    const inviteReward = await getSystemConfigValue('inviteReward', tx)

    const newUser = await tx.user.create({
      data: { email, password: hashedPassword },
    })

    await tx.pointAccount.create({
      data: { userId: newUser.id, balance: registerReward },
    })

    await tx.pointLog.create({
      data: {
        userId: newUser.id,
        type: 'in',
        amount: registerReward,
        balanceAfter: registerReward,
        reason: '新用户注册奖励',
      },
    })

    if (inviteCode) {
      const inviter = await tx.user.findUnique({ where: { inviteCode } })
      if (inviter) {
        await tx.inviteRelation.create({
          data: { inviterId: inviter.id, inviteeId: newUser.id },
        })

        const inviterAccount = await tx.pointAccount.findUnique({ where: { userId: inviter.id } })
        if (inviterAccount) {
          const inviterLifetimeResult = await tx.pointLog.aggregate({
            where: { userId: inviter.id, type: 'in' },
            _sum: { amount: true },
          })
          const inviterLifetimeBefore = inviterLifetimeResult._sum.amount ?? 0
          const tierConfig = await getCurrentTierConfig()
          const inviterTier = resolveTier(inviterLifetimeBefore, tierConfig.thresholds)
          const { bonus, total } = applyTierBonus(inviteReward, inviterTier, tierConfig.bonusBps)
          // Do not derive the next balance from a stale read. Multiple people
          // can register through the same invite code concurrently; an atomic
          // increment preserves every invite reward.
          const updatedAccount = await tx.pointAccount.update({
            where: { userId: inviter.id },
            data: { balance: { increment: total } },
          })
          await tx.pointLog.create({
            data: {
              userId: inviter.id,
              type: 'in',
              amount: total,
              balanceAfter: updatedAccount.balance,
              reason: bonus > 0
                ? `邀请新用户 ${email} 注册奖励 (tier:${inviterTier} +${bonus})`
                : `邀请新用户 ${email} 注册奖励`,
            },
          })
        }
      }
    }

    return { user: newUser, registerReward }
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
    user: buildAuthUser(issued.user, result.registerReward),
  }
}

export async function loginUser(email: string, password: string, ip?: string, userAgent?: string) {
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

    const session = await createStoredRefreshToken(user.id, ip, userAgent, tx, maxAgeMs)
    return { user, session }
  })
  const accessToken = generateAccessToken(issued.user.id, issued.user.role, issued.session.sessionId)

  return {
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
    }
  })

  if (result.kind === 'invalid') throw unauthenticated('Refresh Token 无效')
  if (result.kind === 'reused') throw unauthenticated('Refresh Token 已被使用，请重新登录')
  if (result.kind === 'revoked') throw unauthenticated('Refresh Token 已失效，请重新登录')
  if (result.kind === 'expired') throw unauthenticated('Refresh Token 已过期')
  if (result.kind === 'banned') throw badRequest('账号已被封禁')

  return {
    accessToken: generateAccessToken(result.userId, result.role, result.sessionId),
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
    inviteCode: user.inviteCode,
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

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } })
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
  await mailer.send({
    to: user.email,
    subject: 'MoNexus 密码重置',
    text: `您正在重置 MoNexus 账户的密码。\n\n请在 30 分钟内点击下面的链接完成重置：\n${link}\n\n如非本人操作请忽略此邮件，账户密码不会被更改。`,
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

  const hashed = await bcrypt.hash(newPassword, 10)
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

    await tx.user.update({ where: { id: stored.userId }, data: { password: hashed } })
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
  const hashed = await bcrypt.hash(newPassword, 10)
  await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, userId)
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw notFound('用户不存在')
    if (user.status === '已封禁') throw badRequest('账号已被封禁')

    const valid = await bcrypt.compare(currentPassword, user.password)
    if (!valid) throw unauthenticated('当前密码错误')

    await tx.user.update({
      where: { id: userId },
      data: { password: hashed },
    })
    await tx.passwordResetToken.updateMany({
      where: { userId, used: false },
      data: { used: true },
    })
    await revokeAllUserRefreshTokens(userId, tx)
  })
}

export async function sendEmailVerification(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw notFound('用户不存在')
  if (user.emailVerified) throw badRequest('邮箱已验证')

  const rawToken = generateAuthToken()
  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hashAuthToken(rawToken),
      expiresAt: new Date(Date.now() + config.emailVerificationTokenMaxAgeMs),
    },
  })

  const mailer = await getMailer()
  const link = `${config.appBaseUrl}/verify-email?token=${rawToken}`
  await mailer.send({
    to: user.email,
    subject: 'MoNexus 邮箱验证',
    text: `请在 24 小时内点击下面的链接完成邮箱验证：\n${link}\n\n如非本人操作请忽略此邮件。`,
  })
}

export async function verifyEmailWithToken(rawToken: string) {
  const tokenHash = hashAuthToken(rawToken)
  const stored = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
  })
  if (!stored) throw badRequest('验证链接无效', 'BAD_REQUEST')
  if (stored.used) throw badRequest('验证链接已被使用', 'BAD_REQUEST')
  if (stored.expiresAt < new Date()) throw badRequest('验证链接已过期', 'BAD_REQUEST')

  await prisma.$transaction(async tx => {
    await tx.user.update({
      where: { id: stored.userId },
      data: { emailVerified: new Date() },
    })
    await tx.emailVerificationToken.update({
      where: { id: stored.id },
      data: { used: true },
    })
  })
}
