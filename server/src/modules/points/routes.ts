import { Router } from 'express'
import { authenticate } from '../../middlewares/auth.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate)
router.post('/checkin', controller.checkin)
router.get('/history', controller.history)
router.get('/checkin/status', controller.checkinStatus)

export { router as pointRoutes }
