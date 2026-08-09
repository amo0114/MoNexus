import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { listNotificationsQuerySchema, markAsReadParamsSchema } from './schema.js'
import * as controller from './controller.js'
import { notificationRealtimeStream, notificationStreamRateLimiter } from './realtime/streamController.js'

const router = Router()

router.use(authenticate, requireActiveUser)

router.get('/', validate({ query: listNotificationsQuerySchema }), controller.list)
router.get('/unread-count', controller.unreadCount)
// SSE stream uses its own route limiter (60s connect window), independent of the
// global /api limiter and before the greedy /:id routes.
router.get('/stream', notificationStreamRateLimiter, notificationRealtimeStream)
// read-all before :id/read so "read-all" is not parsed as an id
router.post('/read-all', controller.markAllRead)
router.post('/:id/read', validate({ params: markAsReadParamsSchema }), controller.markRead)

export { router as notificationRoutes }
