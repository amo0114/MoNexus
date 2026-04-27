import { Router } from 'express'
import { authenticate } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { createOrderSchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate)
router.post('/', validate(createOrderSchema), controller.create)
router.get('/', controller.list)

export { router as orderRoutes }
