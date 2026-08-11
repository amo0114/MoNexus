import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { listNotificationsQuerySchema, markAsReadParamsSchema } from './schema.js'
import * as controller from './controller.js'
import { notificationRealtimeStream, notificationStreamRateLimiter } from './realtime/streamController.js'

const router = Router()

// Keep stream admission in its frozen order: dedicated connect limiter first,
// then authentication/status, flags/health/caps, and finally SSE headers.
// app.ts excludes this exact route from the general REST limiter.
router.get(
  '/stream',
  notificationStreamRateLimiter,
  authenticate,
  requireActiveUser,
  notificationRealtimeStream,
)

router.use(authenticate, requireActiveUser)

router.get('/', validate({ query: listNotificationsQuerySchema }), controller.list)
router.get('/unread-count', controller.unreadCount)
// read-all before :id/read so "read-all" is not parsed as an id
router.post('/read-all', controller.markAllRead)
router.post('/:id/read', validate({ params: markAsReadParamsSchema }), controller.markRead)

export { router as notificationRoutes }
