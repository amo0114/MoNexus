import { Router } from 'express'
import { authenticate, requireActiveUser, requireAdmin } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  adjustPointsSchema, banUserSchema, createProductSchema, updateProductSchema,
  importInventorySchema, listUsersQuerySchema, listOrdersQuerySchema,
  revokeDeliveryFileSchema,
  listAdminAuditQuerySchema,
  listMerchantsQuerySchema, reviewMerchantSchema, updateCommissionSchema,
  listSettlementsQuerySchema, batchSettleSchema, resolveOrderSchema,
  systemConfigKeyParamSchema, updateSystemConfigSchema,
  createAnnouncementSchema, updateAnnouncementSchema, listAnnouncementsQuerySchema,
} from './schema.js'
import { adminReviewsQuerySchema } from '../reviews/schema.js'
import * as controller from './controller.js'
import { portableBackupRoutes } from '../portable-backups/routes.js'

const router = Router()

router.use(authenticate, requireActiveUser, requireAdmin)

router.use('/portable-backups', portableBackupRoutes)

router.get('/stats', controller.stats)
router.get('/config', controller.listConfig)
router.put('/config/:key', validate({ params: systemConfigKeyParamSchema, body: updateSystemConfigSchema }), controller.updateConfig)
router.get('/audit', validate({ query: listAdminAuditQuerySchema }), controller.audit)
router.get('/users', validate({ query: listUsersQuerySchema }), controller.users)
router.post('/users/:id/adjust', validate({ params: idParamSchema, body: adjustPointsSchema }), controller.adjustPoints)
router.put('/users/:id/ban', validate({ params: idParamSchema, body: banUserSchema }), controller.banUser)
router.put('/users/:id/unban', validate({ params: idParamSchema }), controller.unbanUser)
router.get('/products', controller.products)
router.post('/products', validate(createProductSchema), controller.createProduct)
router.put('/products/:id', validate({ params: idParamSchema, body: updateProductSchema }), controller.updateProduct)
router.post('/products/:id/inventory', validate({ params: idParamSchema, body: importInventorySchema }), controller.importInventory)
// P5：吊销交付文件（违法/恶意内容治理）。
router.post('/delivery-files/:id/revoke', validate({ params: idParamSchema, body: revokeDeliveryFileSchema }), controller.revokeDeliveryFile)
router.get('/orders', validate({ query: listOrdersQuerySchema }), controller.orders)
router.get('/orders/:id', validate({ params: idParamSchema }), controller.orderDetail)
router.post('/orders/:id/resolve', validate({ params: idParamSchema, body: resolveOrderSchema }), controller.resolveOrder)
router.get('/logs', controller.logs)

// Review moderation
router.get('/reviews', validate({ query: adminReviewsQuerySchema }), controller.listReviews)
router.delete('/reviews/:id', validate({ params: idParamSchema }), controller.removeReview)

// Merchant management
router.get('/merchants', validate({ query: listMerchantsQuerySchema }), controller.listMerchants)
router.get('/merchants/:id', validate({ params: idParamSchema }), controller.merchantDetail)
router.put('/merchants/:id/approve', validate({ params: idParamSchema }), controller.approveMerchant)
router.put('/merchants/:id/reject', validate({ params: idParamSchema, body: reviewMerchantSchema }), controller.rejectMerchant)
router.put('/merchants/:id/suspend', validate({ params: idParamSchema }), controller.suspendMerchant)
router.put('/merchants/:id/commission', validate({ params: idParamSchema, body: updateCommissionSchema }), controller.updateCommission)

// Settlements
router.get('/settlements', validate({ query: listSettlementsQuerySchema }), controller.listSettlements)
router.post('/settlements/batch-settle', validate(batchSettleSchema), controller.batchSettle)

// Announcements
router.get('/announcements', validate({ query: listAnnouncementsQuerySchema }), controller.listAnnouncementsRoute)
router.post('/announcements', validate(createAnnouncementSchema), controller.createAnnouncementRoute)
router.put('/announcements/:id', validate({ params: idParamSchema, body: updateAnnouncementSchema }), controller.updateAnnouncementRoute)
router.delete('/announcements/:id', validate({ params: idParamSchema }), controller.deleteAnnouncementRoute)

export { router as adminRoutes }
