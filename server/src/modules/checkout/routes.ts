import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import * as controller from './controller.js'

export const previewQuerySchema = z.object({
  productId: z.coerce.number().int().positive(),
})

const router = Router()

router.use(authenticate, requireActiveUser)
router.get('/preview', validate({ query: previewQuerySchema }), controller.preview)

export { router as checkoutRoutes }
