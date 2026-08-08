import { Request, Response, NextFunction } from 'express'
import { refreshTokenCookieName, setRefreshTokenCookie, clearRefreshTokenCookie } from '../../lib/cookies.js'
import { HttpError, unauthenticated } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import * as authService from './service.js'
import * as sessionService from './sessionService.js'

function currentSessionId(req: Request) {
  if (typeof req.user?.sid !== 'string') throw unauthenticated('登录会话已失效，请重新登录')
  return req.user.sid
}

const PASSWORD_RESET_PROTECTION_ERRORS = new Set([
  'HUMAN_VERIFICATION_REQUIRED',
  'HUMAN_VERIFICATION_FAILED',
  'HUMAN_VERIFICATION_UNAVAILABLE',
  'ABUSE_PROTECTION_UNAVAILABLE',
])

function isPasswordResetProtectionError(error: unknown): error is HttpError {
  return error instanceof HttpError && PASSWORD_RESET_PROTECTION_ERRORS.has(error.code)
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, inviteCode, turnstileToken, agreements, nickname } = req.body
    const result = await authService.registerUser(
      email, password, nickname, inviteCode,
      req.ip, req.headers['user-agent'], turnstileToken, agreements,
    )
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
    res.status(201).json({ user: result.user, accessToken: result.accessToken })
  } catch (err) {
    next(err)
  }
}

export async function registrationStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    const status = await authService.getPublicRegistrationStatus()
    // 开关是运营实时状态：任何中间缓存都会让访客看到已经作废的注册入口。
    res.set('Cache-Control', 'no-store')
    res.json(status)
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
    if (result.kind === 'mfa_challenge') {
      // A password-authenticated administrator remains pre-authenticated
      // until MFA succeeds. In particular, never set the refresh cookie here.
      res.status(202).json({
        status: result.status,
        challengeId: result.challengeId,
        expiresAt: result.expiresAt.toISOString(),
      })
      return
    }
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
    res.json({ user: result.user, accessToken: result.accessToken })
  } catch (err) {
    next(err)
  }
}

export async function startMfaEnrollment(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.startAdminMfaEnrollment(req.body.challengeId)
    res.json({
      provisioningUri: result.provisioningUri,
      manualKey: result.manualKey,
      expiresAt: result.expiresAt.toISOString(),
    })
  } catch (err) {
    next(err)
  }
}

export async function confirmMfaEnrollment(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.confirmAdminMfaEnrollment({
      challengeId: req.body.challengeId,
      code: req.body.code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
    res.status(201).json({
      user: result.user,
      accessToken: result.accessToken,
      recoveryCodes: result.recoveryCodes,
    })
  } catch (err) {
    next(err)
  }
}

export async function verifyMfa(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.verifyAdminMfaLogin({
      challengeId: req.body.challengeId,
      method: req.body.method,
      code: req.body.code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    setRefreshTokenCookie(res, result.refreshToken, result.refreshTokenMaxAgeMs)
    res.json({
      user: result.user,
      accessToken: result.accessToken,
      ...(result.recoveryCodeRemaining === undefined ? {} : { recoveryCodeRemaining: result.recoveryCodeRemaining }),
    })
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
      await authService.revokeRefreshToken(refreshToken, req.ip, req.headers['user-agent'])
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

export async function updateMe(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await authService.updateUserProfile(req.user!.userId, req.body)
    res.json(profile)
  } catch (err) {
    next(err)
  }
}

export async function sessions(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await sessionService.listActiveSessions(req.user!.userId, currentSessionId(req))
    res.json({ items })
  } catch (err) {
    next(err)
  }
}

export async function revokeSession(req: Request, res: Response, next: NextFunction) {
  try {
    await sessionService.revokeOwnedNonCurrentSession({
      userId: req.user!.userId,
      currentSessionId: currentSessionId(req),
      targetSessionId: String(req.params.sessionId),
      metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
    })
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export async function revokeOtherSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await sessionService.revokeOtherSessions({
      userId: req.user!.userId,
      currentSessionId: currentSessionId(req),
      metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
}

// Always returns 200 with the same payload, whether or not the email
// exists. Hiding the result prevents account enumeration via this
// endpoint while still letting real users get a reset link.
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.requestPasswordReset(req.body.email, req.ip, req.body.turnstileToken)
  } catch (err) {
    if (isPasswordResetProtectionError(err)) {
      next(err)
      return
    }
    // This endpoint is intentionally indistinguishable for known/unknown
    // addresses, throttles, database errors, and SMTP failures. Security
    // dependency errors above are the exception: the client must be able to
    // distinguish a missing/failed challenge from an account-independent
    // operational failure and retry appropriately. Do not attach the caught
    // error: provider and SMTP details can include sensitive request context.
    logger.warn({ flow: 'password_reset', outcome: 'suppressed' }, 'password reset request suppressed')
  }
  res.json({ message: '如果该邮箱已注册，重置链接已发送' })
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
    await authService.sendEmailVerification(req.user!.userId, req.ip)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.verifyEmailWithToken(req.user!.userId, req.body.token)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}

/**
 * Old emails can contain a query token, but accepting it here would let mail
 * scanners or a different browser verify an account anonymously. Deliberately
 * return a token-free terminal response and make no service/database call.
 */
export function legacyVerifyEmail(_req: Request, res: Response) {
  res.set('Cache-Control', 'no-store')
  res.status(410).json({
    error: {
      code: 'BAD_REQUEST',
      message: '验证链接已失效，请登录后重新发送验证邮件',
    },
  })
}
