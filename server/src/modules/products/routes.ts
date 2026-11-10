import { Router } from 'express'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'
import { listProductsQuerySchema, productSummariesQuerySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.get('/', authenticateIfPresent, requireActiveUserIfPresent, validate({ query: listProductsQuerySchema }), controller.list)
router.get('/summaries', controller.noStoreHeaders, authenticateIfPresent, requireActiveUserIfPresent, validate({ query: productSummariesQuerySchema }), controller.summaries)
router.get('/:id/recommendations', controller.noStoreHeaders, authenticateIfPresent, requireActiveUserIfPresent, validate({ params: idParamSchema }), controller.recommendations)
router.get('/:id', authenticateIfPresent, requireActiveUserIfPresent, validate({ params: idParamSchema }), controller.detail)

export { router as productRoutes }
