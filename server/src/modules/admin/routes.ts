import { Router } from 'express'
import { authenticate, requireAdmin } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { adjustPointsSchema, createProductSchema, updateProductSchema, importInventorySchema, listUsersQuerySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate, requireAdmin)

router.get('/stats', controller.stats)
router.get('/users', validate({ query: listUsersQuerySchema }), controller.users)
router.post('/users/:id/adjust', validate({ params: idParamSchema, body: adjustPointsSchema }), controller.adjustPoints)
router.get('/products', controller.products)
router.post('/products', validate(createProductSchema), controller.createProduct)
router.put('/products/:id', validate({ params: idParamSchema, body: updateProductSchema }), controller.updateProduct)
router.post('/products/:id/inventory', validate({ params: idParamSchema, body: importInventorySchema }), controller.importInventory)
router.get('/orders', controller.orders)
router.get('/logs', controller.logs)

export { router as adminRoutes }
