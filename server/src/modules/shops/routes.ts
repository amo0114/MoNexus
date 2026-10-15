import { Router } from 'express'
import { validate } from '../../middlewares/validate.js'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'
import { noStoreHeaders } from '../products/controller.js'
import { shopParamsSchema, shopProductsQuerySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.get(
  '/:merchantId/products',
  noStoreHeaders,
  authenticateIfPresent,
  requireActiveUserIfPresent,
  validate({ params: shopParamsSchema, query: shopProductsQuerySchema }),
  controller.products,
)

export { router as shopRoutes }
