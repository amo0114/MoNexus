import { Response } from 'express'
import { config } from '../config/index.js'
import { unauthenticated } from './httpError.js'

export const refreshTokenCookieName = 'refreshToken'

const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax' as const,
  path: '/api/auth',
}

export function setRefreshTokenCookie(
  res: Response,
  refreshToken: string,
  expiresAtOrMaxAgeMs: Date | number,
  now: Date = new Date(),
) {
  let maxAgeMs: number
  if (expiresAtOrMaxAgeMs instanceof Date) {
    const remainingMs = expiresAtOrMaxAgeMs.getTime() - now.getTime()
    if (remainingMs < 1_000) {
      throw unauthenticated('Refresh Token 已过期')
    }
    maxAgeMs = Math.floor(remainingMs / 1_000) * 1_000
  } else {
    maxAgeMs = expiresAtOrMaxAgeMs
  }

  res.cookie(refreshTokenCookieName, refreshToken, {
    ...refreshTokenCookieOptions,
    maxAge: maxAgeMs,
  })
}

export function clearRefreshTokenCookie(res: Response) {
  res.clearCookie(refreshTokenCookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/auth',
  })
}
