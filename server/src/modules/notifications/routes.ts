import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { listNotificationsQuerySchema, markAsReadParamsSchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate, requireActiveUser)

router.get('/', validate({ query: listNotificationsQuerySchema }), controller.list)
router.get('/unread-count', controller.unreadCount)
// read-all before :id/read so "read-all" is not parsed as an id
router.post('/read-all', controller.markAllRead)
router.post('/:id/read', validate({ params: markAsReadParamsSchema }), controller.markRead)

export { router as notificationRoutes }
