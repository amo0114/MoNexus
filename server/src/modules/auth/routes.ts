import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validate } from '../../middlewares/validate.js'
import { authenticate } from '../../middlewares/auth.js'
import { registerSchema, loginSchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '认证请求过于频繁，请稍后再试',
    },
  },
})

router.post('/register', authLimiter, validate(registerSchema), controller.register)
router.post('/login', authLimiter, validate(loginSchema), controller.login)
router.post('/refresh', authLimiter, controller.refresh)
router.post('/logout', controller.logout)
router.get('/me', authenticate, controller.me)

export { router as authRoutes }
