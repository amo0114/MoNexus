import { Router } from 'express'
import {
  authenticate,
  authenticateIfPresent,
  requireActiveUser,
  requireActiveUserIfPresent,
  requireVerifiedEmail,
} from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import * as controller from './controller.js'
import { productReviewsQuerySchema, reviewBodySchema } from './schema.js'

// 两个路由分别与 orderRoutes / productRoutes 共用前缀，鉴权挂在单条路由上，避免
// router.use 让同前缀的其他接口重复鉴权。
const orderReviewRoutes = Router()
orderReviewRoutes.post('/:id/review', authenticate, requireActiveUser, validate({ params: idParamSchema, body: reviewBodySchema }), requireVerifiedEmail, controller.createForOrder)
orderReviewRoutes.put('/:id/review', authenticate, requireActiveUser, validate({ params: idParamSchema, body: reviewBodySchema }), requireVerifiedEmail, controller.updateForOrder)

const productReviewRoutes = Router()
productReviewRoutes.get('/:id/reviews', authenticateIfPresent, requireActiveUserIfPresent, validate({ params: idParamSchema, query: productReviewsQuerySchema }), controller.listForProduct)

export { orderReviewRoutes, productReviewRoutes }
