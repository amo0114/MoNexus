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

function generateAccessToken(userId: number, role: string) {
  return jwt.sign({ userId, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
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
  ip?: string,
  userAgent?: string,
  tx?: Prisma.TransactionClient,
  configuredMaxAgeMs?: number,
) {
  const refreshToken = generateRefreshToken()
  const maxAgeMs = configuredMaxAgeMs ?? await getRefreshTokenMaxAgeMs()
  const client = tx ?? prisma
  await client.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + maxAgeMs),
      ip,
      userAgent,
    },
  })
  return { refreshToken, maxAgeMs }
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

  const { refreshToken, maxAgeMs } = await createStoredRefreshToken(result.user.id, ip, userAgent)
  const accessToken = generateAccessToken(result.user.id, result.user.role)

  return {
    accessToken,
    refreshToken,
    refreshTokenMaxAgeMs: maxAgeMs,
    user: buildAuthUser(result.user, result.registerReward),
  }
}

export async function loginUser(email: string, password: string, ip?: string, userAgent?: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { pointAccount: true },
  })
  if (!user) throw unauthenticated('邮箱或密码错误')
  if (user.status === '已封禁') throw badRequest('账号已被封禁')

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) throw unauthenticated('邮箱或密码错误')

  const { refreshToken, maxAgeMs } = await createStoredRefreshToken(user.id, ip, userAgent)
  const accessToken = generateAccessToken(user.id, user.role)

  return {
    accessToken,
    refreshToken,
    refreshTokenMaxAgeMs: maxAgeMs,
    user: buildAuthUser(user, user.pointAccount?.balance ?? 0),
  }
}

export async function refreshAccessToken(rawRefreshToken: string, ip?: string, userAgent?: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken)
  const now = new Date()
  // Read the runtime setting once, then use the same duration for the DB row
  // and cookie returned by the winning rotation.
  const maxAgeMs = await getRefreshTokenMaxAgeMs()

  const result = await prisma.$transaction(async tx => {
    // We intentionally look up revoked rows too: presenting one is a refresh
    // token replay and must revoke the rest of the user's session family.
    const storedToken = await tx.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    })

    if (!storedToken) return { kind: 'invalid' as const }

    if (storedToken.revoked) {
      await revokeAllUserRefreshTokens(storedToken.userId, tx)
      return { kind: 'reused' as const }
    }

    if (storedToken.expiresAt < now) {
      await tx.refreshToken.updateMany({
        where: { id: storedToken.id, revoked: false },
        data: { revoked: true },
      })
      return { kind: 'expired' as const }
    }

    if (storedToken.user.status === '已封禁') return { kind: 'banned' as const }

    // Compare-and-set is the critical part of rotation. A plain read followed
    // by update lets two concurrent requests both mint successor tokens.
    const revoked = await tx.refreshToken.updateMany({
      where: {
        id: storedToken.id,
        tokenHash,
        revoked: false,
        expiresAt: { gte: now },
      },
      data: { revoked: true },
    })

    if (revoked.count !== 1) {
      // A concurrent request has consumed this token. Treat it exactly as a
      // replay, including revoking the just-issued successor if one exists.
      // Keeping this inside the same transaction prevents a race that could
      // otherwise leave a successor active after reuse was detected.
      await revokeAllUserRefreshTokens(storedToken.userId, tx)
      return { kind: 'reused' as const }
    }

    const next = await createStoredRefreshToken(
      storedToken.userId,
      ip,
      userAgent,
      tx,
      maxAgeMs,
    )
    return {
      kind: 'rotated' as const,
      userId: storedToken.userId,
      role: storedToken.user.role,
      refreshToken: next.refreshToken,
    }
  })

  if (result.kind === 'invalid') throw unauthenticated('Refresh Token 无效')
  if (result.kind === 'reused') throw unauthenticated('Refresh Token 已被使用，请重新登录')
  if (result.kind === 'expired') throw unauthenticated('Refresh Token 已过期')
  if (result.kind === 'banned') throw badRequest('账号已被封禁')

  return {
    accessToken: generateAccessToken(result.userId, result.role),
    refreshToken: result.refreshToken,
    refreshTokenMaxAgeMs: maxAgeMs,
  }
}

export async function revokeRefreshToken(rawRefreshToken: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken)
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revoked: false },
    data: { revoked: true },
  })
}

export async function revokeAllUserRefreshTokens(
  userId: number,
  tx?: Prisma.TransactionClient
) {
  const client = tx ?? prisma
  await client.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true },
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
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw notFound('用户不存在')
  if (user.status === '已封禁') throw badRequest('账号已被封禁')

  const valid = await bcrypt.compare(currentPassword, user.password)
  if (!valid) throw unauthenticated('当前密码错误')

  const hashed = await bcrypt.hash(newPassword, 10)
  await prisma.$transaction(async tx => {
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
