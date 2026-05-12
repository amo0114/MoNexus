import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, notFound, unauthenticated } from '../../lib/httpError.js'
import { getMailer } from '../../lib/mailer/index.js'

function generateAccessToken(userId: number, role: string) {
  return jwt.sign({ userId, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex')
}

function hashRefreshToken(refreshToken: string) {
  return crypto.createHash('sha256').update(refreshToken).digest('hex')
}

function buildAuthUser(user: { id: number; email: string; role: string; inviteCode: string; status: string }, points = 0) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    inviteCode: user.inviteCode,
    points,
  }
}

async function createStoredRefreshToken(userId: number, ip?: string, userAgent?: string) {
  const refreshToken = generateRefreshToken()
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + config.refreshTokenMaxAgeMs),
      ip,
      userAgent,
    },
  })
  return refreshToken
}

export async function registerUser(email: string, password: string, inviteCode?: string, ip?: string, userAgent?: string) {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) throw conflict('该邮箱已注册')

  const hashedPassword = await bcrypt.hash(password, 10)

  const user = await prisma.$transaction(async tx => {
    const newUser = await tx.user.create({
      data: { email, password: hashedPassword },
    })

    await tx.pointAccount.create({
      data: { userId: newUser.id, balance: config.registerReward },
    })

    await tx.pointLog.create({
      data: {
        userId: newUser.id,
        type: 'in',
        amount: config.registerReward,
        balanceAfter: config.registerReward,
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
          const newBalance = inviterAccount.balance + config.inviteReward
          await tx.pointAccount.update({
            where: { userId: inviter.id },
            data: { balance: newBalance },
          })
          await tx.pointLog.create({
            data: {
              userId: inviter.id,
              type: 'in',
              amount: config.inviteReward,
              balanceAfter: newBalance,
              reason: `邀请新用户 ${email} 注册奖励`,
            },
          })
        }
      }
    }

    return newUser
  })

  const refreshToken = await createStoredRefreshToken(user.id, ip, userAgent)
  const accessToken = generateAccessToken(user.id, user.role)

  return {
    accessToken,
    refreshToken,
    user: buildAuthUser(user, config.registerReward),
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

  const refreshToken = await createStoredRefreshToken(user.id, ip, userAgent)
  const accessToken = generateAccessToken(user.id, user.role)

  return {
    accessToken,
    refreshToken,
    user: buildAuthUser(user, user.pointAccount?.balance ?? 0),
  }
}

export async function refreshAccessToken(rawRefreshToken: string, ip?: string, userAgent?: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken)

  // Look up token regardless of revoked status for reuse detection
  const storedToken = await prisma.refreshToken.findFirst({
    where: { tokenHash },
    include: { user: true },
  })

  if (!storedToken) throw unauthenticated('Refresh Token 无效')

  // Reuse detection: if token is already revoked, an attacker may have stolen it.
  // Revoke the entire token family for this user to force re-login.
  if (storedToken.revoked) {
    await prisma.refreshToken.updateMany({
      where: { userId: storedToken.userId, revoked: false },
      data: { revoked: true },
    })
    throw unauthenticated('Refresh Token 已被使用，请重新登录')
  }

  if (storedToken.expiresAt < new Date()) {
    await prisma.refreshToken.update({ where: { id: storedToken.id }, data: { revoked: true } })
    throw unauthenticated('Refresh Token 已过期')
  }
  if (storedToken.user.status === '已封禁') throw badRequest('账号已被封禁')

  // Rotate: revoke the old token, issue a new one
  await prisma.refreshToken.update({ where: { id: storedToken.id }, data: { revoked: true } })
  const refreshToken = await createStoredRefreshToken(storedToken.userId, ip, userAgent)
  const accessToken = generateAccessToken(storedToken.userId, storedToken.user.role)

  return { accessToken, refreshToken }
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
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashAuthToken(rawToken),
      expiresAt: new Date(Date.now() + config.passwordResetTokenMaxAgeMs),
    },
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
  await prisma.$transaction(async tx => {
    await tx.user.update({ where: { id: stored.userId }, data: { password: hashed } })
    await tx.passwordResetToken.update({ where: { id: stored.id }, data: { used: true } })
    // Revoke every refresh token outstanding for this user — if the
    // password is being reset, assume the prior session is compromised.
    await revokeAllUserRefreshTokens(stored.userId, tx)
  })
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
