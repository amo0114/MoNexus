import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { validate } from '../../middlewares/validate.js'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { config } from '../../config/index.js'
import { refreshTokenCookieName } from '../../lib/cookies.js'
import {
  registerSchema,
  loginSchema,
  mfaEnrollmentStartSchema,
  mfaEnrollmentConfirmSchema,
  mfaVerifySchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  passwordChangeSchema,
  sessionIdParamSchema,
  verifyEmailSchema,
  updateMeSchema,
  humanChallengeQuerySchema,
} from './schema.js'
import * as controller from './controller.js'
import * as authService from './service.js'

const router = Router()

// Bypass rate limits under NODE_ENV=test so the suite can blast many
// auth calls per second without hitting the 5/15min cap.
const skipInTests = () => config.nodeEnv === 'test'

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '认证请求过于频繁，请稍后再试',
    },
  },
})

// A valid refresh cookie is a per-session credential, not a password-guessing
// attempt. Key it by a one-way hash of that cookie so users behind the same
// office NAT / reverse proxy never consume one another's refresh allowance.
// Requests without a cookie still use the IPv6-safe client IP key.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: (req) => {
    const refreshToken = req.cookies?.[refreshTokenCookieName]
    if (typeof refreshToken === 'string' && refreshToken.length > 0) {
      return `refresh:${crypto.createHash('sha256').update(refreshToken).digest('hex')}`
    }
    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
  },
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '刷新请求过于频繁，请稍后再试',
    },
  },
})

/**
 * Keep the public switch ahead of request validation and every limiter. The
 * service repeats this check as its non-bypassable boundary for direct callers
 * and to close the switch-flip race between middleware and controller.
 */
async function registrationGate(_req: Request, _res: Response, next: NextFunction) {
  try {
    await authService.assertRegistrationEnabled()
    next()
  } catch (error) {
    next(error)
  }
}

// 公开只读：访客登录页据此决定是否展示注册入口。刻意不挂 authLimiter——
// 它是按"认证尝试"标定的额度，页面加载不该消耗；只读且无副作用，全局
// /api limiter 已足够（C17/F9）。
router.get('/registration-status', controller.registrationStatus)
router.get('/human-challenge', validate({ query: humanChallengeQuerySchema }), controller.humanChallenge)

// Registration deliberately does not use the process-local authLimiter. Its
// service boundary owns the fixed order: switch -> Redis preflight ->
// human verification -> shared Redis buckets -> bcrypt/DB/session. Putting a
// memory limiter before that boundary would both weaken multi-instance
// protection and let it consume/reject a request before the registration
// switch is observed.
router.post('/register', registrationGate, validate(registerSchema), controller.register)
router.post('/login', authLimiter, validate(loginSchema), controller.login)
router.post('/mfa/enrollment/start', authLimiter, validate(mfaEnrollmentStartSchema), controller.startMfaEnrollment)
router.post('/mfa/enrollment/confirm', authLimiter, validate(mfaEnrollmentConfirmSchema), controller.confirmMfaEnrollment)
router.post('/mfa/verify', authLimiter, validate(mfaVerifySchema), controller.verifyMfa)
router.post('/refresh', refreshLimiter, controller.refresh)
router.post('/logout', controller.logout)
router.get('/me', authenticate, requireActiveUser, controller.me)
router.patch('/me', authenticate, requireActiveUser, validate(updateMeSchema), controller.updateMe)
router.get('/sessions', authenticate, requireActiveUser, controller.sessions)
router.delete('/sessions/:sessionId', authenticate, requireActiveUser, validate({ params: sessionIdParamSchema }), controller.revokeSession)
router.post('/sessions/revoke-others', authenticate, requireActiveUser, controller.revokeOtherSessions)
router.post('/password-change', authLimiter, authenticate, requireActiveUser, validate(passwordChangeSchema), controller.changePassword)

// These two sending routes use the shared, HMAC-keyed Redis policies in the
// service. A process-local mail limiter would be bypassable across instances.
router.post('/forgot-password', validate(forgotPasswordSchema), controller.forgotPassword)
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), controller.resetPassword)
router.post('/send-verification', authenticate, requireActiveUser, controller.sendVerification)
router.post('/verify-email', authenticate, requireActiveUser, validate(verifyEmailSchema), controller.verifyEmail)
// Query-string verification links may remain in old inboxes. Never parse or
// consume their token here: the authenticated POST is the sole write path.
router.get('/verify-email', controller.legacyVerifyEmail)

export { router as authRoutes }
