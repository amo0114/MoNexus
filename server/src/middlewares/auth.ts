import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import {
  emailVerificationRequired,
  forbidden,
  mfaRequired,
  sessionRevoked,
  unauthenticated,
} from '../lib/httpError.js'
import { prisma } from '../lib/prisma.js'
import { getSystemConfigValue } from '../lib/systemConfig.js'
import { getCached, setCached } from '../lib/userStatusCache.js'

export interface AuthPayload {
  userId: number
  role: string
  /** Stable refresh-token family ID for newly issued access tokens. */
  sid?: string
  /** Present only after an administrator completed an MFA factor. */
  mfaVerified?: boolean
  /** Invalidates prior administrator access tokens after MFA security changes. */
  mfaVersion?: number
  /** JWT standard `exp` claim (seconds since epoch) — used for SSE auth timers. */
  exp?: number
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    next(unauthenticated('未登录'))
    return
  }

  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload
    req.user = payload
    next()
  } catch {
    next(unauthenticated('Token 已过期，请重新登录'))
  }
}

/**
 * Populate req.user when a bearer token is supplied, while keeping endpoints
 * accessible to visitors without one. A malformed or expired supplied token
 * still receives the normal 401 response so the client can refresh it.
 */
export function authenticateIfPresent(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    next()
    return
  }
  authenticate(req, res, next)
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    next(forbidden('需要管理员权限'))
    return
  }
  next()
}

export type AdminMfaSessionState = 'allowed' | 'mfa_required' | 'session_revoked' | 'forbidden'

/**
 * Resolves the complete administrator MFA/session invariant once so routes
 * outside `/api/admin` can delegate instead of reinventing a weaker check.
 * It returns a state (rather than throwing) because the public announcements
 * endpoint must safely downgrade an invalid admin token to visitor audience.
 */
export async function getAdminMfaSessionState(payload: AuthPayload): Promise<AdminMfaSessionState> {
  if (payload.role !== 'admin') return 'forbidden'
  if (typeof payload.sid !== 'string' || payload.sid.length === 0) return 'session_revoked'
  const mfaVersion = payload.mfaVersion
  if (payload.mfaVerified !== true || typeof mfaVersion !== 'number' || !Number.isSafeInteger(mfaVersion) || mfaVersion < 0) {
    return 'mfa_required'
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { role: true, status: true, mfaEnabled: true, mfaVersion: true },
  })
  if (!user) return 'session_revoked'
  if (user.status === '已封禁') return 'forbidden'
  if (user.role !== 'admin') return 'forbidden'
  if (!user.mfaEnabled || user.mfaVersion !== mfaVersion) return 'mfa_required'

  const activeSession = await prisma.refreshToken.findFirst({
    where: {
      userId: payload.userId,
      sessionId: payload.sid,
      revoked: false,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  })
  return activeSession ? 'allowed' : 'session_revoked'
}

export async function requireAdminMfa(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(unauthenticated('未登录'))
    return
  }

  try {
    const state = await getAdminMfaSessionState(req.user)
    if (state === 'allowed') {
      next()
      return
    }
    if (state === 'session_revoked') {
      next(sessionRevoked())
      return
    }
    if (state === 'mfa_required') {
      next(mfaRequired())
      return
    }
    next(forbidden('需要管理员权限'))
  } catch (err) {
    next(err)
  }
}

/**
 * Buyer and merchant file access must retain their current semantics, while
 * the special administrator evidence path gets the exact same MFA guard as
 * `/api/admin`. This must be placed before file-access controller work.
 */
export function requireMfaIfAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    next()
    return
  }
  void requireAdminMfa(req, res, next)
}

export async function requireActiveUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(unauthenticated('未登录'))
    return
  }

  try {
    const userId = req.user.userId
    // Admin routes are low volume and privilege-sensitive; always read
    // their current status before authorization.
    const shouldUseCache = req.user.role !== 'admin'
    let status = shouldUseCache ? getCached(userId) : undefined

    if (!status) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { status: true },
      })

      if (!user) {
        next(unauthenticated('未登录'))
        return
      }

      status = user.status
      if (shouldUseCache) {
        setCached(userId, status)
      }
    }

    if (status === '已封禁') {
      next(forbidden('账号已被封禁'))
      return
    }

    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Gate the small set of value-bearing writes that are explicitly covered by
 * SPEC-RAP-001.  The flag and verification timestamp are deliberately read
 * from PostgreSQL for every request: neither a JWT claim nor a client-side
 * profile cache is an authorization source.
 *
 * Routes still place `requireActiveUser` before this middleware.  Rechecking
 * status here keeps the middleware safe when reused directly and, more
 * importantly, preserves the existing ban/not-found result before exposing
 * an email-verification state.
 */
export async function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(unauthenticated('未登录'))
    return
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { status: true, emailVerified: true },
    })

    if (!user) {
      next(unauthenticated('未登录'))
      return
    }

    // Keep the established active-user/ban semantics ahead of the value gate.
    if (user.status === '已封禁') {
      next(forbidden('账号已被封禁'))
      return
    }

    const gateEnabled = (await getSystemConfigValue('emailVerificationRequiredForValue')) === 1
    // Treat an absent value as unverified as well.  Prisma returns `null` for
    // this nullable column, but the nullish check keeps the authorization
    // decision fail-closed if a test double or future projection omits it.
    if (!gateEnabled || user.emailVerified != null) {
      next()
      return
    }

    next(emailVerificationRequired())
  } catch (err) {
    // Deliberately forward the original error so the global handler emits the
    // generic INTERNAL_SERVER_ERROR response without leaking DB details.
    next(err)
  }
}

export async function requireMerchant(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'merchant') {
    next(forbidden('需要商家权限'))
    return
  }

  try {
    const merchant = await prisma.merchant.findUnique({
      where: { userId: req.user.userId },
      select: { status: true },
    })

    if (!merchant || merchant.status !== 'active') {
      next(forbidden('需要已激活商家权限'))
      return
    }

    next()
  } catch (err) {
    next(err)
  }
}
