import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import {
  confirmProvisionCode,
  listBoundEmails,
  provisionEmailStatus,
  sendProvisionCode,
} from './controller.js'
import {
  provisionEmailBodySchema,
  provisionEmailConfirmSchema,
  provisionEmailStatusQuerySchema,
} from './schema.js'

const router = Router()

const skipInTests = () => process.env.NODE_ENV === 'test'

const mailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
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

const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '验证过于频繁，请稍后再试',
    },
  },
})

router.post(
  '/provision-email/send-code',
  mailLimiter,
  authenticate,
  requireActiveUser,
  validate(provisionEmailBodySchema),
  sendProvisionCode
)
router.post(
  '/provision-email/confirm',
  confirmLimiter,
  authenticate,
  requireActiveUser,
  validate(provisionEmailConfirmSchema),
  confirmProvisionCode
)
router.get(
  '/provision-email/status',
  authenticate,
  requireActiveUser,
  validate({ query: provisionEmailStatusQuerySchema }),
  provisionEmailStatus
)
router.get(
  '/provision-email/bound',
  authenticate,
  requireActiveUser,
  listBoundEmails
)

export { router as fakaBridgeRoutes }
