import { Router } from 'express'
import { authenticate, requireActiveUser, requireVerifiedEmail } from '../../middlewares/auth.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.post('/checkin', requireVerifiedEmail, controller.checkin)
router.get('/history', controller.history)
router.get('/checkin/status', controller.checkinStatus)
router.get('/tier', controller.tier)

export { router as pointRoutes }
