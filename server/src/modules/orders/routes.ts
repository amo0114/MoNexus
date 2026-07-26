import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { createOrderSchema, listOrdersQuerySchema } from './schema.js'
import * as controller from './controller.js'
import * as reviewsController from '../reviews/controller.js'
import { reviewBodySchema } from '../reviews/schema.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.post('/', validate(createOrderSchema), controller.create)
router.get('/', validate({ query: listOrdersQuerySchema }), controller.list)
router.post('/:id/dispute', validate({ params: idParamSchema }), controller.dispute)
router.post('/:id/close', validate({ params: idParamSchema }), controller.close)
// P6a：手动续费预检（买家；只读，无副作用）。
router.post('/:id/renew', validate({ params: idParamSchema }), controller.renewPrecheck)
router.post('/:id/review', validate({ params: idParamSchema, body: reviewBodySchema }), reviewsController.createForOrder)
router.put('/:id/review', validate({ params: idParamSchema, body: reviewBodySchema }), reviewsController.updateForOrder)
// P5：受控文件下载的唯一发放入口（买家/商家/管理员，语义见 fileAccess.ts）。
router.post('/:id/files/download-url', validate({ params: idParamSchema }), controller.issueFileDownloadUrl)
router.get('/:id', validate({ params: idParamSchema }), controller.detail)

export { router as orderRoutes }
