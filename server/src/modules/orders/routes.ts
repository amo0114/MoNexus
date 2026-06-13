import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { createOrderSchema, listOrdersQuerySchema } from './schema.js'
import * as controller from './controller.js'
import * as reviewsController from '../reviews/controller.js'
import { reviewBodySchema } from '../reviews/schema.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.post('/', validate(createOrderSchema), controller.create)
router.get('/', validate({ query: listOrdersQuerySchema }), controller.list)
router.post('/:id/dispute', validate({ params: idParamSchema }), controller.dispute)
router.post('/:id/close', validate({ params: idParamSchema }), controller.close)
router.post('/:id/review', validate({ params: idParamSchema, body: reviewBodySchema }), reviewsController.createForOrder)
router.put('/:id/review', validate({ params: idParamSchema, body: reviewBodySchema }), reviewsController.updateForOrder)
router.get('/:id', validate({ params: idParamSchema }), controller.detail)

export { router as orderRoutes }
