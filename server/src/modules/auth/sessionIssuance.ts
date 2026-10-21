import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { createRefreshTokenRecord } from './sessionService.js'
import { resolveUserNickname } from '../../lib/defaultNickname.js'

type MfaSessionClaims = {
  verified: true
  version: number
}

export function generateAccessToken(userId: number, role: string, sessionId: string, mfa?: MfaSessionClaims) {
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

export function hashRefreshToken(refreshToken: string) {
  return crypto.createHash('sha256').update(refreshToken).digest('hex')
}

export function buildAuthUser(user: { id: number; email: string; role: string; status: string; nickname: string | null; avatarUrl?: string | null }, points = 0) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    nickname: resolveUserNickname(user),
    avatarUrl: user.avatarUrl ?? null,
    points,
  }
}

export async function createStoredRefreshToken(
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
