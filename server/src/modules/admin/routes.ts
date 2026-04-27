import { Router } from 'express'
import { authenticate, requireAdmin } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { adjustPointsSchema, createProductSchema, updateProductSchema, importInventorySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.use(authenticate, requireAdmin)

router.get('/stats', controller.stats)
router.get('/users', controller.users)
router.post('/users/:id/adjust', validate(adjustPointsSchema), controller.adjustPoints)
router.get('/products', controller.products)
router.post('/products', validate(createProductSchema), controller.createProduct)
router.put('/products/:id', validate(updateProductSchema), controller.updateProduct)
router.post('/products/:id/inventory', validate(importInventorySchema), controller.importInventory)
router.get('/orders', controller.orders)
router.get('/logs', controller.logs)

export { router as adminRoutes }
