import { Response } from 'express'
import { config } from '../config/index.js'

export const refreshTokenCookieName = 'refreshToken'

const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax' as const,
  path: '/api/auth',
}

export function setRefreshTokenCookie(res: Response, refreshToken: string, maxAgeMs: number) {
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
