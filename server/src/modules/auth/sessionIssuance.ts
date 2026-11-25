import { merchantCapabilities } from '../merchantGovernance/lifecycle.js'
import { legacyStatus } from '../accountGovernance/status.js'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { unauthenticated } from '../../lib/httpError.js'
import { createRefreshTokenRecord, enforceUserActiveSessionLimit } from './sessionService.js'
import { computeSessionExpiry, resolveClampedJwtExp } from './sessionPolicy.js'
import { resolveUserNickname } from '../../lib/defaultNickname.js'

type MfaSessionClaims = {
  verified: true
  version: number
}

export function generateAccessToken(
  userId: number,
  role: string,
  sessionId: string,
  mfa?: MfaSessionClaims,
  sessionDeadline?: Date,
  now: Date = new Date(),
) {
  const basePayload = {
    userId,
    role,
    sid: sessionId,
    ...(role === 'admin' && mfa ? { mfaVerified: true, mfaVersion: mfa.version } : {}),
  }

  if (sessionDeadline instanceof Date) {
    const exp = resolveClampedJwtExp(sessionDeadline, now)
    if (exp === null) {
      throw unauthenticated('登录会话已过期，请重新登录')
    }
    // Sign with an explicit integer `exp` so signing latency after DB commit
    // can never push the JWT past the persisted session deadline.
    return jwt.sign({ ...basePayload, exp }, config.jwtSecret)
  }

  return jwt.sign(basePayload, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex')
}

export function hashRefreshToken(refreshToken: string) {
  return crypto.createHash('sha256').update(refreshToken).digest('hex')
}

export function buildAuthUser(user: { id: number; email: string; role: string; status: string; nickname: string | null; avatarUrl?: string | null; merchant?: { status: string; lifecycleVersion: number } | null }, points = 0) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: legacyStatus(user.status === 'banned' || user.status === '已封禁' ? 'banned' : 'active'),
    accountStatus: user.status === 'banned' || user.status === '已封禁' ? 'banned' : 'active',
    merchantStatus: user.merchant?.status ?? null,
    merchantLifecycleVersion: user.merchant?.lifecycleVersion ?? null,
    merchantCapabilities: merchantCapabilities(user.merchant?.status ?? null, !['active','正常'].includes(user.status)),
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
  existingSession?: { sessionId: string; sessionStartedAt: Date; expiresAt: Date; absoluteExpiresAt?: Date | null },
  role: string = 'user',
  now: Date = new Date(),
) {
  const expiry = computeSessionExpiry({
    role,
    configuredMaxAgeMs,
    now,
    existing: existingSession
      ? {
          sessionStartedAt: existingSession.sessionStartedAt,
          expiresAt: existingSession.expiresAt,
          absoluteExpiresAt: existingSession.absoluteExpiresAt ?? null,
        }
      : undefined,
  })
  if (expiry.expired) {
    throw unauthenticated('Refresh Token 已过期')
  }

  // Enforce the per-user active family cap only when issuing a new family.
  if (existingSession === undefined) {
    await enforceUserActiveSessionLimit(tx, userId, now, { ip, userAgent })
  }

  const refreshToken = generateRefreshToken()
  const stored = await createRefreshTokenRecord({
    userId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: expiry.expiresAt,
    absoluteExpiresAt: expiry.absoluteExpiresAt,
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
  return {
    refreshToken,
    expiresAt: expiry.expiresAt,
    absoluteExpiresAt: expiry.absoluteExpiresAt,
    sessionId: stored.sessionId,
  }
}
