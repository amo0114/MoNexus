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
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
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
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
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
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
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

// Always returns 200 with the same payload, whether or not the email
// exists. Hiding the result prevents account enumeration via this
// endpoint while still letting real users get a reset link.
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.requestPasswordReset(req.body.email)
    res.json({ message: '如果该邮箱已注册，重置链接已发送' })
  } catch (err) {
    next(err)
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.resetPasswordWithToken(req.body.token, req.body.password)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.changePassword(
      req.user!.userId,
      req.body.currentPassword,
      req.body.newPassword
    )
    res.json({ message: '密码已修改，请重新登录' })
  } catch (err) {
    next(err)
  }
}

export async function sendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.sendEmailVerification(req.user!.userId)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const token = String(req.query.token ?? '')
    await authService.verifyEmailWithToken(token)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}
