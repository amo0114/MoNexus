import { adminSourceDescriptionRouter } from '../catalog/sourceDescriptionRoutes.js'
import { Router } from 'express'
import { z } from 'zod'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { fakaSettings } from './fakaSettings.js'
import * as controller from './fakaController.js'
import {
  addFakaOffersSchema, confirmFakaSyncSchema, importFakaPlanSchema, listFakaTasksQuerySchema,
  previewFakaPlanSchema, rebindOfferSkuSchema, setFakaCapacitySchema,
} from './schema.js'

export const fakaAdminRoutes = Router()
const router = fakaAdminRoutes
router.use(adminSourceDescriptionRouter)
const adminOfferParamSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
  offerId: z.coerce.number().int().positive('必须是正整数'),
})

router.use('/integrations/faka-bridge/config', fakaSettings.router)
router.post(
  '/products/:id/offers/:offerId/rebind-sku/preview',
  validate({ params: adminOfferParamSchema, body: rebindOfferSkuSchema }),
  controller.previewRebindOfferSku,
)
router.post(
  '/products/:id/offers/:offerId/rebind-sku',
  validate({ params: adminOfferParamSchema, body: rebindOfferSkuSchema }),
  controller.rebindOfferSku,
)
router.post('/products/:id/faka-sync/preview', validate({ params: idParamSchema }), controller.previewFakaSync)
router.post(
  '/products/:id/faka-sync',
  validate({ params: idParamSchema, body: confirmFakaSyncSchema }),
  controller.confirmFakaSync,
)
// FakaBridge Xboard 管理：仅平台管理员（本路由组已 requireAdmin + MFA）
router.get('/faka/catalog', controller.fakaCatalog)
router.post('/faka/import/preview', validate(previewFakaPlanSchema), controller.previewFakaPlan)
router.post('/faka/import', validate(importFakaPlanSchema), controller.importFakaPlan)
router.post(
  '/products/:id/faka-offers',
  validate({ params: idParamSchema, body: addFakaOffersSchema }),
  controller.addFakaOffers
)
router.put(
  '/products/:id/faka-capacity',
  validate({ params: idParamSchema, body: setFakaCapacitySchema }),
  controller.setFakaCapacity
)
router.get('/faka/tasks', validate({ query: listFakaTasksQuerySchema }), controller.listFakaTasks)
router.get('/faka/tasks/stats', controller.fakaTaskStats)
router.post('/faka/tasks/:id/retry', validate({ params: idParamSchema }), controller.retryFakaTask)
router.post('/faka/tasks/:id/revoke', validate({ params: idParamSchema }), controller.forceFakaRevoke)
