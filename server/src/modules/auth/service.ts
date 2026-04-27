import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { config } from '../../config/index.js'

export const prisma = new PrismaClient()

function generateAccessToken(userId: number, role: string) {
  return jwt.sign({ userId, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex')
}

export async function registerUser(email: string, password: string, inviteCode?: string, ip?: string, userAgent?: string) {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) throw new Error('该邮箱已注册')

  const hashedPassword = await bcrypt.hash(password, 10)

  const user = await prisma.$transaction(async (tx) => {
    // 创建用户
    const newUser = await tx.user.create({
      data: { email, password: hashedPassword },
    })

    // 创建积分账户并赠送注册积分
    await tx.pointAccount.create({
      data: { userId: newUser.id, balance: config.registerReward },
    })

    // 写积分流水
    await tx.pointLog.create({
      data: {
        userId: newUser.id,
        type: 'in',
        amount: config.registerReward,
        balanceAfter: config.registerReward,
        reason: '新用户注册奖励',
      },
    })

    // 处理邀请关系
    if (inviteCode) {
      const inviter = await tx.user.findUnique({ where: { inviteCode } })
      if (inviter) {
        await tx.inviteRelation.create({
          data: { inviterId: inviter.id, inviteeId: newUser.id },
        })

        // 给邀请人增加积分
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

  // 创建 Refresh Token
  const rawRefreshToken = generateRefreshToken()
  const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ip,
      userAgent,
    },
  })

  const accessToken = generateAccessToken(user.id, user.role)

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    user: { id: user.id, email: user.email, role: user.role, inviteCode: user.inviteCode },
  }
}

export async function loginUser(email: string, password: string, ip?: string, userAgent?: string) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) throw new Error('邮箱或密码错误')
  if (user.status === '已封禁') throw new Error('账号已被封禁')

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) throw new Error('邮箱或密码错误')

  // 创建 Refresh Token
  const rawRefreshToken = generateRefreshToken()
  const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ip,
      userAgent,
    },
  })

  const accessToken = generateAccessToken(user.id, user.role)

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    user: { id: user.id, email: user.email, role: user.role, inviteCode: user.inviteCode },
  }
}

export async function refreshAccessToken(rawRefreshToken: string) {
  const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')

  const storedToken = await prisma.refreshToken.findFirst({
    where: { tokenHash, revoked: false },
    include: { user: true },
  })

  if (!storedToken) throw new Error('Refresh Token 无效')
  if (storedToken.expiresAt < new Date()) {
    await prisma.refreshToken.update({ where: { id: storedToken.id }, data: { revoked: true } })
    throw new Error('Refresh Token 已过期')
  }
  if (storedToken.user.status === '已封禁') throw new Error('账号已被封禁')

  // Token 轮换：旧 token 作废，签发新 token
  await prisma.refreshToken.update({ where: { id: storedToken.id }, data: { revoked: true } })

  const newRawRefresh = generateRefreshToken()
  const newHash = crypto.createHash('sha256').update(newRawRefresh).digest('hex')
  await prisma.refreshToken.create({
    data: {
      userId: storedToken.userId,
      tokenHash: newHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  })

  const accessToken = generateAccessToken(storedToken.userId, storedToken.user.role)

  return { accessToken, refreshToken: newRawRefresh }
}

export async function getUserProfile(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { pointAccount: true },
  })
  if (!user) throw new Error('用户不存在')

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    inviteCode: user.inviteCode,
    points: user.pointAccount?.balance ?? 0,
    createdAt: user.createdAt,
  }
}
