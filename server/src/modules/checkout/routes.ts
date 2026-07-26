import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import * as controller from './controller.js'

export const previewQuerySchema = z.object({
  productId: z.coerce.number().int().positive(),
  // 购买的规格（P4a）。可选：单 SKU 商品由服务端解析为唯一 active Offer。
  offerId: z.coerce.number().int().positive().optional(),
})

const router = Router()

router.use(authenticate, requireActiveUser)
router.get('/preview', validate({ query: previewQuerySchema }), controller.preview)

export { router as checkoutRoutes }
