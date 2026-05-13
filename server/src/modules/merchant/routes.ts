import { Router } from 'express'
import { authenticate, requireActiveUser, requireMerchant } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  applyMerchantSchema, updateMerchantSchema,
  createMerchantProductSchema, updateMerchantProductSchema,
  importMerchantInventorySchema, merchantListQuerySchema,
} from './schema.js'
import * as controller from './controller.js'

const router = Router()

// Registration: any authenticated user can apply
router.post('/register', authenticate, requireActiveUser, validate(applyMerchantSchema), controller.apply)

// All other routes require merchant role
router.use(authenticate, requireActiveUser, requireMerchant)

router.get('/me', controller.me)
router.put('/me', validate(updateMerchantSchema), controller.updateMe)

router.get('/products', validate({ query: merchantListQuerySchema }), controller.listProducts)
router.post('/products', validate(createMerchantProductSchema), controller.createProduct)
router.put('/products/:id', validate({ params: idParamSchema, body: updateMerchantProductSchema }), controller.updateProduct)
router.post('/products/:id/inventory', validate({ params: idParamSchema, body: importMerchantInventorySchema }), controller.importInventory)

router.get('/orders', validate({ query: merchantListQuerySchema }), controller.listOrders)
router.get('/orders/:id', validate({ params: idParamSchema }), controller.orderDetail)

router.get('/settlements', validate({ query: merchantListQuerySchema }), controller.listSettlements)
router.get('/stats', controller.stats)

export { router as merchantRoutes }
