import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { subscribeBodySchema, unsubscribeBodySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.get('/public-key', controller.publicKey)
router.post('/subscriptions', validate({ body: subscribeBodySchema }), controller.subscribe)
router.delete('/subscriptions', validate({ body: unsubscribeBodySchema }), controller.unsubscribe)

export { router as pushRoutes }
