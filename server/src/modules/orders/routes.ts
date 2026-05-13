import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { createOrderSchema, listOrdersQuerySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.post('/', validate(createOrderSchema), controller.create)
router.get('/', validate({ query: listOrdersQuerySchema }), controller.list)
router.get('/:id', validate({ params: idParamSchema }), controller.detail)

export { router as orderRoutes }
