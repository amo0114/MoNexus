// T-MERCH-BE-003 — Promotion package/campaign routers (SPEC-MERCH-001 §11).
//
// Route definitions with auth middleware, exported for the CMI Integration
// Owner to mount (app.ts / global main wiring is NOT owned by this lane —
// same rule as the ranking admin routes). Merchant lanes use the shared
// authenticate → requireActiveUser → requireMerchant guard; admin lanes use
// authenticate → requireActiveUser → requireAdmin → requireAdminMfa.
//
// Merchant campaign create REQUIRES the `Idempotency-Key` header (Spec §11);
// the controller reads it, so no body field may carry a key.

import { Router } from 'express'
import { authenticate, requireActiveUser, requireAdmin, requireAdminMfa, requireMerchant } from '../../../middlewares/auth.js'
import { validate, idParamSchema } from '../../../middlewares/validate.js'
import * as controller from './controller.js'
import {
  cancelCampaignSchema,
  adminCancelCampaignSchema,
  adjustRefundSchema,
  createCampaignSchema,
  createPackageSchema,
  listCampaignsQuerySchema,
  listPackagesQuerySchema,
  rejectCampaignSchema,
  noBodySchema,
  retryPaymentSchema,
  updatePackageSchema,
} from './schema.js'

const merchantPromotionRouter = Router()
merchantPromotionRouter.use(authenticate, requireActiveUser, requireMerchant)

merchantPromotionRouter.get('/promotion-packages', validate({ query: listPackagesQuerySchema }), controller.listPackages)
merchantPromotionRouter.get('/promotion-campaigns', validate({ query: listCampaignsQuerySchema }), controller.listCampaigns)
merchantPromotionRouter.post(
  '/promotion-campaigns',
  validate(createCampaignSchema),
  controller.createCampaign,
)
merchantPromotionRouter.post(
  '/promotion-campaigns/:id/cancel',
  validate({ params: idParamSchema, body: cancelCampaignSchema }),
  controller.cancelCampaign,
)
merchantPromotionRouter.post(
  '/promotion-campaigns/:id/retry-payment',
  validate({ params: idParamSchema, body: retryPaymentSchema }),
  controller.merchantRetryPayment,
)

const adminPromotionRouter = Router()
adminPromotionRouter.use(authenticate, requireActiveUser, requireAdmin, requireAdminMfa)

adminPromotionRouter.get('/promotion-packages', validate({ query: listPackagesQuerySchema }), controller.adminListPackages)
adminPromotionRouter.post('/promotion-packages', validate(createPackageSchema), controller.adminCreatePackage)
adminPromotionRouter.patch(
  '/promotion-packages/:id',
  validate({ params: idParamSchema, body: updatePackageSchema }),
  controller.adminUpdatePackage,
)
adminPromotionRouter.get('/promotion-campaigns', validate({ query: listCampaignsQuerySchema }), controller.adminListCampaigns)
adminPromotionRouter.post(
  '/promotion-campaigns/:id/reject',
  validate({ params: idParamSchema, body: rejectCampaignSchema }),
  controller.adminRejectCampaign,
)
adminPromotionRouter.post(
  '/promotion-campaigns/:id/approve',
  validate({ params: idParamSchema, body: noBodySchema }),
  controller.adminApproveCampaign,
)
adminPromotionRouter.post(
  '/promotion-campaigns/:id/pause',
  validate({ params: idParamSchema, body: noBodySchema }),
  controller.adminPauseCampaign,
)
adminPromotionRouter.post(
  '/promotion-campaigns/:id/resume',
  validate({ params: idParamSchema, body: noBodySchema }),
  controller.adminResumeCampaign,
)
adminPromotionRouter.post(
  '/promotion-campaigns/:id/cancel',
  validate({ params: idParamSchema, body: adminCancelCampaignSchema }),
  controller.adminCancelCampaign,
)
adminPromotionRouter.post(
  '/promotion-campaigns/:id/refund-adjustment',
  validate({ params: idParamSchema, body: adjustRefundSchema }),
  controller.adminRefundAdjustment,
)

export { merchantPromotionRouter, adminPromotionRouter }
