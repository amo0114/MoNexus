import { Router } from 'express'
import { authenticate, requireActiveUser, requireAdmin, requireAdminMfa } from '../../middlewares/auth.js'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  adjustPointsSchema, banUserSchema, createProductSchema, updateProductSchema,
  importInventorySchema, listUsersQuerySchema, listOrdersQuerySchema,
  previewInventorySchema, previewOfferInventorySchema, importOfferInventorySchema,
  revokeDeliveryFileSchema,
  listDeliveryFilesQuerySchema, listFileGrantsQuerySchema, offerReportQuerySchema,
  listAdminAuditQuerySchema,
  listMerchantsQuerySchema, reviewMerchantSchema, updateCommissionSchema,
  listSettlementsQuerySchema, batchSettleSchema, resolveOrderSchema,
  systemConfigKeyParamSchema, updateSystemConfigSchema,
  createAnnouncementSchema, updateAnnouncementSchema, listAnnouncementsQuerySchema,
  setFakaCapacitySchema, previewFakaPlanSchema, importFakaPlanSchema, addFakaOffersSchema,
  listFakaTasksQuerySchema,
  mailDeliveryTestSchema,
  abuseOverviewQuerySchema,
  listAbuseReferralsQuerySchema,
  listAbuseRewardsQuerySchema,
  setReferralSuspensionSchema,
  voidAbuseRewardSchema,
} from './schema.js'
import { adminReviewsQuerySchema } from '../reviews/schema.js'
import * as controller from './controller.js'
import * as abuseController from './abuseController.js'
import * as storageController from './storageController.js'
import {
  createStorageProviderSchema,
  updateStorageProviderSchema,
} from './storageSchema.js'
import { adminMailTestLimiter } from './mailTestLimiter.js'
import { portableBackupRoutes } from '../portable-backups/routes.js'
import { valuePolicyGovernanceRoutes } from '../valuePolicy/governanceRoutes.js'
// T-CAT-BE-001：分类管理 API。仅挂载子 router——本文件顶部的
// authenticate→requireActiveUser→requireAdmin→requireAdminMfa 链已覆盖其权限边界。
import { categoryAdminRoutes } from '../catalog/adminRoutes.js'
import { categoryApplicationAdminRoutes } from '../catalog/applicationAdminRoutes.js'
import { rechargeAdminRoutes } from '../recharge/adminRoutes.js'
import { z } from 'zod'

const router = Router()

router.use(authenticate, requireActiveUser, requireAdmin, requireAdminMfa)

// T-CAT-BE-004（D-CAT-12/13）：新 Offer-first 路径的 URL 参数。
const adminOfferParamSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
  offerId: z.coerce.number().int().positive('必须是正整数'),
})

router.use('/portable-backups', portableBackupRoutes)
router.use('/value-policies', valuePolicyGovernanceRoutes)
// T-CAT-BE-001 §7.2：admin product-categories（列表/CRUD/排序/启停/删除）。
router.use('/product-categories', categoryAdminRoutes)
// T-CAT-BE-002 §7.3：管理员分类申请审核（列表/approve/reject，CAS + AdminLog）。
router.use('/category-applications', categoryApplicationAdminRoutes)
router.use(rechargeAdminRoutes)

router.get('/stats', controller.stats)
router.get('/config', controller.listConfig)
router.put('/config/:key', validate({ params: systemConfigKeyParamSchema, body: updateSystemConfigSchema }), controller.updateConfig)
router.get('/audit', validate({ query: listAdminAuditQuerySchema }), controller.audit)
// SPEC-RAP-001: this entire router has already passed authenticate → active
// user → admin role → current MFA session. Keep the abuse surface here rather
// than a separately mounted router so no future route can accidentally omit
// the MFA boundary.
router.get('/abuse/overview', validate({ query: abuseOverviewQuerySchema }), abuseController.overview)
router.get('/abuse/referrals', validate({ query: listAbuseReferralsQuerySchema }), abuseController.referrals)
router.get('/abuse/rewards', validate({ query: listAbuseRewardsQuerySchema }), abuseController.rewards)
router.put(
  '/abuse/users/:id/referral-suspension',
  validate({ params: idParamSchema, body: setReferralSuspensionSchema }),
  abuseController.setReferralSuspension,
)
router.post(
  '/abuse/rewards/:id/void',
  validate({ params: idParamSchema, body: voidAbuseRewardSchema }),
  abuseController.voidReward,
)
// SPEC-OPS-REGMAIL-001：邮件投递运营面。挂在本 router 的
// authenticate→requireActiveUser→requireAdmin→requireAdminMfa 之后即天然受
// MFA 保护；限流器在 body 校验之前，保证畸形请求同样消耗额度（C5）。
router.get('/mail/status', controller.mailStatus)
router.post('/mail/test', adminMailTestLimiter, validate(mailDeliveryTestSchema), controller.mailTest)
// SPEC-STORAGE-001：对象存储控制台（MFA 已由本 router 统一要求）
router.get('/storage/status', storageController.storageStatus)
router.get('/storage/providers', storageController.listStorageProviders)
router.post(
  '/storage/providers',
  validate(createStorageProviderSchema),
  storageController.createStorageProvider,
)
router.patch(
  '/storage/providers/:id',
  validate({ params: idParamSchema, body: updateStorageProviderSchema }),
  storageController.updateStorageProvider,
)
router.post(
  '/storage/providers/:id/test',
  validate({ params: idParamSchema }),
  storageController.testStorageProvider,
)
router.post(
  '/storage/providers/:id/activate',
  validate({ params: idParamSchema }),
  storageController.activateStorageProvider,
)
router.post(
  '/storage/providers/:id/rollback',
  validate({ params: idParamSchema }),
  storageController.rollbackStorageProvider,
)
router.post(
  '/storage/providers/:id/disable',
  validate({ params: idParamSchema }),
  storageController.disableStorageProvider,
)
router.get('/users', validate({ query: listUsersQuerySchema }), controller.users)
router.post('/users/:id/adjust', validate({ params: idParamSchema, body: adjustPointsSchema }), controller.adjustPoints)
router.put('/users/:id/ban', validate({ params: idParamSchema, body: banUserSchema }), controller.banUser)
router.put('/users/:id/unban', validate({ params: idParamSchema }), controller.unbanUser)
router.get('/products', controller.products)
router.post('/products', validate(createProductSchema), controller.createProduct)
router.put('/products/:id', validate({ params: idParamSchema, body: updateProductSchema }), controller.updateProduct)
router.get('/products/:id/readiness', validate({ params: idParamSchema }), controller.productReadiness)
router.post('/products/:id/publish', validate({ params: idParamSchema }), controller.publishProduct)
router.post('/products/:id/unpublish', validate({ params: idParamSchema }), controller.unpublishProduct)
router.delete('/products/:id', validate({ params: idParamSchema }), controller.deleteProduct)
router.post('/products/:id/inventory', validate({ params: idParamSchema, body: importInventorySchema }), controller.importInventory)
// T-CAT-BE-004（D-CAT-15）：管理员库存先 preview → confirm，与商家共用领域分析器。
router.post('/products/:id/inventory/preview', validate({ params: idParamSchema, body: previewInventorySchema }), controller.previewInventory)
// T-CAT-BE-004（D-CAT-12/13）：新 Offer-first 路径，offerId 显式在 URL。
router.post('/products/:id/offers/:offerId/inventory/preview', validate({ params: adminOfferParamSchema, body: previewOfferInventorySchema }), controller.previewOfferInventory)
router.post('/products/:id/offers/:offerId/inventory', validate({ params: adminOfferParamSchema, body: importOfferInventorySchema }), controller.importOfferInventory)
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
// P5：吊销交付文件（违法/恶意内容治理）。
router.post('/delivery-files/:id/revoke', validate({ params: idParamSchema, body: revokeDeliveryFileSchema }), controller.revokeDeliveryFile)
// P5.5 T1：文件治理——分页列表 + 单文件签名发放流水（审计）。
router.get('/delivery-files', validate({ query: listDeliveryFilesQuerySchema }), controller.listDeliveryFiles)
router.get('/delivery-files/:id/grants', validate({ params: idParamSchema, query: listFileGrantsQuerySchema }), controller.deliveryFileGrants)
// P5.5 T2：全平台热销规格报表（净成交口径）。
router.get('/reports/offers', validate({ query: offerReportQuerySchema }), controller.offerReport)
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
