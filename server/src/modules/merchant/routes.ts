import { Router } from 'express'
import { authenticate, requireActiveUser, requireMerchant, requireVerifiedEmail } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  applyMerchantSchema, updateMerchantSchema,
  createMerchantProductSchema, updateMerchantProductSchema,
  importMerchantInventorySchema, merchantListQuerySchema,
  importMerchantOfferInventorySchema,
  merchantOrderListQuerySchema, startFulfillmentSchema,
  deliverFulfillmentSchema, respondDisputeSchema, rejectOrderSchema,
  orderProgressSchema,
  merchantProductListQuerySchema, previewMerchantInventorySchema,
  previewMerchantOfferInventorySchema,
  voidMerchantInventorySchema, merchantInventoryLogQuerySchema,
  voidMerchantOfferInventorySchema,
  adjustMerchantProductCapacitySchema,
  adjustMerchantOfferCapacitySchema,
  createMerchantOfferSchema, updateMerchantOfferSchema,
  merchantWebhookConfigSchema,
} from './schema.js'
import * as controller from './controller.js'
import { categoryApplicationRoutes } from '../catalog/applicationRoutes.js'
import { z } from 'zod'

const offerParamSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
  offerId: z.coerce.number().int().positive('必须是正整数'),
})

const router = Router()

// Registration: any authenticated user can apply
router.post('/register', authenticate, requireActiveUser, validate(applyMerchantSchema), requireVerifiedEmail, controller.apply)

// All other routes require merchant role
router.use(authenticate, requireActiveUser, requireMerchant)

router.get('/me', controller.me)
router.put('/me', validate(updateMerchantSchema), controller.updateMe)

router.get('/products', validate({ query: merchantProductListQuerySchema }), controller.listProducts)
router.post('/products', validate(createMerchantProductSchema), controller.createProduct)
router.put('/products/:id', validate({ params: idParamSchema, body: updateMerchantProductSchema }), controller.updateProduct)
router.get('/products/:id/readiness', validate({ params: idParamSchema }), controller.productReadiness)
router.post('/products/:id/publish', validate({ params: idParamSchema }), controller.publishProduct)
router.post('/products/:id/unpublish', validate({ params: idParamSchema }), controller.unpublishProduct)
router.post('/products/:id/capacity/adjust', validate({ params: idParamSchema, body: adjustMerchantProductCapacitySchema }), controller.adjustProductCapacity)
router.post('/products/:id/inventory/preview', validate({ params: idParamSchema, body: previewMerchantInventorySchema }), controller.previewInventory)
router.post('/products/:id/inventory', validate({ params: idParamSchema, body: importMerchantInventorySchema }), controller.importInventory)
router.post('/products/:id/inventory/void', validate({ params: idParamSchema, body: voidMerchantInventorySchema }), controller.voidInventory)
router.get('/products/:id/inventory/logs', validate({ params: idParamSchema, query: merchantInventoryLogQuerySchema }), controller.listInventoryLogs)

// T-CAT-BE-004（D-CAT-12/13）：新 Offer-first 路径，offerId 显式在 URL；旧路径保留默认 Offer 兼容。
router.post('/products/:id/offers/:offerId/inventory/preview', validate({ params: offerParamSchema, body: previewMerchantOfferInventorySchema }), controller.previewOfferInventory)
router.post('/products/:id/offers/:offerId/inventory', validate({ params: offerParamSchema, body: importMerchantOfferInventorySchema }), controller.importOfferInventory)
router.post('/products/:id/offers/:offerId/inventory/void', validate({ params: offerParamSchema, body: voidMerchantOfferInventorySchema }), controller.voidOfferInventory)
router.post('/products/:id/offers/:offerId/capacity/adjust', validate({ params: offerParamSchema, body: adjustMerchantOfferCapacitySchema }), controller.adjustOfferCapacity)

// P4a：SKU/规格管理
router.get('/products/:id/offers', validate({ params: idParamSchema }), controller.listOffers)
router.post('/products/:id/offers', validate({ params: idParamSchema, body: createMerchantOfferSchema }), controller.createOffer)
router.put('/products/:id/offers/:offerId', validate({ params: offerParamSchema, body: updateMerchantOfferSchema }), controller.updateOffer)
router.delete('/products/:id/offers/:offerId', validate({ params: offerParamSchema }), controller.deleteOffer)

router.get('/orders', validate({ query: merchantOrderListQuerySchema }), controller.listOrders)
router.get('/orders/:id', validate({ params: idParamSchema }), controller.orderDetail)
router.post('/orders/:id/fulfillment/start', validate({ params: idParamSchema, body: startFulfillmentSchema }), controller.startFulfillment)
router.post('/orders/:id/fulfillment/deliver', validate({ params: idParamSchema, body: deliverFulfillmentSchema }), controller.deliverFulfillment)
// P6b：履约进度更新（不改订单状态，仅追加买家可见的时间线事件）
router.post('/orders/:id/progress', validate({ params: idParamSchema, body: orderProgressSchema }), controller.postProgress)
router.post('/orders/:id/fulfillment/respond-dispute', validate({ params: idParamSchema, body: respondDisputeSchema }), controller.respondDispute)
router.post('/orders/:id/fulfillment/reject', validate({ params: idParamSchema, body: rejectOrderSchema }), controller.rejectOrder)

router.get('/settlements', validate({ query: merchantListQuerySchema }), controller.listSettlements)
router.get('/stats', controller.stats)

// P7b：自动开通 webhook 配置（secret 明文仅在 PUT 响应一次性返回）
router.get('/webhook-config', controller.getWebhookConfig)
router.put('/webhook-config', validate(merchantWebhookConfigSchema), controller.saveWebhookConfig)
router.delete('/webhook-config', controller.revokeWebhookConfig)
router.post('/webhook-config/test', controller.testWebhookConfig)

// T-CAT-BE-002 §7.3：商家分类申请（列表/创建/撤回，强制 ownership）。
router.use('/category-applications', categoryApplicationRoutes)

export { router as merchantRoutes }
