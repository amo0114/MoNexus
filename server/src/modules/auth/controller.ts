import { Request, Response, NextFunction } from 'express'
import { refreshTokenCookieName, setRefreshTokenCookie, clearRefreshTokenCookie } from '../../lib/cookies.js'
import { unauthenticated } from '../../lib/httpError.js'
import * as authService from './service.js'

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, inviteCode } = req.body
    const result = await authService.registerUser(
      email, password, inviteCode,
      req.ip, req.headers['user-agent']
    )
    setRefreshTokenCookie(res, result.refreshToken)
    res.status(201).json({ user: result.user, accessToken: result.accessToken })
  } catch (err) {
    next(err)
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body
    const result = await authService.loginUser(
      email, password,
      req.ip, req.headers['user-agent']
    )
    setRefreshTokenCookie(res, result.refreshToken)
    res.json({ user: result.user, accessToken: result.accessToken })
  } catch (err) {
    next(err)
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const refreshToken = req.cookies?.[refreshTokenCookieName]
    if (!refreshToken) throw unauthenticated('Refresh Token 缺失')

    const result = await authService.refreshAccessToken(
      refreshToken,
      req.ip,
      req.headers['user-agent']
    )
    setRefreshTokenCookie(res, result.refreshToken)
    res.json({ accessToken: result.accessToken })
  } catch (err) {
    next(err)
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const refreshToken = req.cookies?.[refreshTokenCookieName]
    if (refreshToken) {
      await authService.revokeRefreshToken(refreshToken)
    }
    clearRefreshTokenCookie(res)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await authService.getUserProfile(req.user!.userId)
    res.json(profile)
  } catch (err) {
    next(err)
  }
}
