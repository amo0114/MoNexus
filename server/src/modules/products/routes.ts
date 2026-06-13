import { Router } from 'express'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { listProductsQuerySchema } from './schema.js'
import * as controller from './controller.js'
import * as reviewsController from '../reviews/controller.js'
import { productReviewsQuerySchema } from '../reviews/schema.js'

const router = Router()

router.get('/', validate({ query: listProductsQuerySchema }), controller.list)
router.get('/:id/reviews', validate({ params: idParamSchema, query: productReviewsQuerySchema }), reviewsController.listForProduct)
router.get('/:id', validate({ params: idParamSchema }), controller.detail)

export { router as productRoutes }
