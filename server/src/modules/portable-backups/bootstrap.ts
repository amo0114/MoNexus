import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { badRequest, forbidden } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'

export async function getRestoreBootstrapStatus() {
  const userCount = await prisma.user.count()
  return {
    available: Boolean(config.portableRestoreBootstrapToken) && userCount === 0,
  }
}
export async function createRestoreBootstrapAdmin(token: string, email: string, password: string) {
  if (!matchesBootstrapToken(token)) {
    throw forbidden('恢复引导不可用')
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12)
    await prisma.$transaction(async tx => {
      if (await tx.user.count() !== 0) {
        throw badRequest('恢复引导已关闭：当前实例已有用户')
      }
      await tx.user.create({
        data: {
          email: email.trim().toLowerCase(),
          password: passwordHash,
          role: 'admin',
          status: '正常',
          emailVerified: new Date(),
        },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2034') {
      throw badRequest('恢复引导已被其他请求完成，请刷新页面')
    }
    throw err
  }
}

function matchesBootstrapToken(candidate: string) {
  const expected = config.portableRestoreBootstrapToken
  if (!expected) return false
  const expectedBuffer = Buffer.from(expected)
  const candidateBuffer = Buffer.from(candidate)
  return expectedBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(expectedBuffer, candidateBuffer)
}
