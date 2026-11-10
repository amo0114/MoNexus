import { Router } from 'express'
import { authenticate, requireActiveUser, requireVerifiedEmail } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import * as controller from './controller.js'
import { makeupBodySchema, rewardParamsSchema } from './schema.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.post('/checkin', requireVerifiedEmail, controller.checkin)
router.get('/history', controller.history)
router.get('/checkin/status', controller.checkinStatus)
router.post('/checkin/makeup', requireVerifiedEmail, validate({ body: makeupBodySchema }), controller.makeup)
router.post(
  '/checkin/rewards/:id/claim',
  requireVerifiedEmail,
  validate({ params: rewardParamsSchema }),
  controller.claimReward,
)
router.get('/tier', controller.tier)

export { router as pointRoutes }
