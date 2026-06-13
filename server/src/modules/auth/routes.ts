import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validate } from '../../middlewares/validate.js'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { config } from '../../config/index.js'
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  passwordChangeSchema,
  verifyEmailQuerySchema,
  updateMeSchema,
} from './schema.js'
import * as controller from './controller.js'

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

// Tighter limit on the email-sending endpoints to make
// enumeration / spam attacks more expensive.
const mailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试',
    },
  },
})

router.post('/register', authLimiter, validate(registerSchema), controller.register)
router.post('/login', authLimiter, validate(loginSchema), controller.login)
router.post('/refresh', authLimiter, controller.refresh)
router.post('/logout', controller.logout)
router.get('/me', authenticate, requireActiveUser, controller.me)
router.patch('/me', authenticate, requireActiveUser, validate(updateMeSchema), controller.updateMe)
router.post('/password-change', authLimiter, authenticate, requireActiveUser, validate(passwordChangeSchema), controller.changePassword)

router.post('/forgot-password', mailLimiter, validate(forgotPasswordSchema), controller.forgotPassword)
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), controller.resetPassword)
router.post('/send-verification', mailLimiter, authenticate, requireActiveUser, controller.sendVerification)
router.get('/verify-email', validate({ query: verifyEmailQuerySchema }), controller.verifyEmail)

export { router as authRoutes }
