import { Router } from 'express'
import { validate } from '../../middlewares/validate.js'
import * as controller from './adminController.js'
import {
  adminCreatePricePolicySchema,
  adminCreateReconSchema,
  adminListDisputesQuerySchema,
  adminListEventsQuerySchema,
  adminListOrdersQuerySchema,
  adminListPricePoliciesQuerySchema,
  adminPatchPricePolicySchema,
  adminRefundSchema,
  adminResolveDisputeSchema,
  adminCloseRecoveryCaseSchema,
  adminUuidParamSchema,
} from './adminSchema.js'

export const rechargeAdminRoutes = Router()

rechargeAdminRoutes.get(
  '/recharge/orders',
  validate({ query: adminListOrdersQuerySchema }),
  controller.listOrders,
)
rechargeAdminRoutes.get(
  '/recharge/orders/:id',
  validate({ params: adminUuidParamSchema }),
  controller.getOrder,
)
rechargeAdminRoutes.post(
  '/recharge/orders/:id/reconcile',
  validate({ params: adminUuidParamSchema }),
  controller.reconcileOrder,
)
rechargeAdminRoutes.post(
  '/recharge/orders/:id/refunds',
  validate({ params: adminUuidParamSchema, body: adminRefundSchema }),
  controller.requestRefund,
)
rechargeAdminRoutes.post(
  '/recharge/sandbox/orders/:id/confirm',
  validate({ params: adminUuidParamSchema }),
  controller.confirmSandboxOrder,
)
rechargeAdminRoutes.get(
  '/recharge/price-policies',
  validate({ query: adminListPricePoliciesQuerySchema }),
  controller.listPricePolicies,
)
rechargeAdminRoutes.post(
  '/recharge/price-policies',
  validate({ body: adminCreatePricePolicySchema }),
  controller.createPricePolicy,
)
rechargeAdminRoutes.patch(
  '/recharge/price-policies/:id',
  validate({ params: adminUuidParamSchema, body: adminPatchPricePolicySchema }),
  controller.patchPricePolicy,
)
rechargeAdminRoutes.post(
  '/recharge/price-policies/:id/activate',
  validate({ params: adminUuidParamSchema }),
  controller.activatePricePolicy,
)
rechargeAdminRoutes.get(
  '/payments/events',
  validate({ query: adminListEventsQuerySchema }),
  controller.listEvents,
)
rechargeAdminRoutes.post(
  '/payments/events/:id/retry',
  validate({ params: adminUuidParamSchema }),
  controller.retryEvent,
)
rechargeAdminRoutes.get('/payments/reconciliation-runs', controller.listReconRuns)
rechargeAdminRoutes.post(
  '/payments/reconciliation-runs',
  validate(adminCreateReconSchema),
  controller.createReconRun,
)
rechargeAdminRoutes.post(
  '/payments/reconciliation-runs/:id/rerun',
  validate({ params: adminUuidParamSchema }),
  controller.rerunRecon,
)
rechargeAdminRoutes.get(
  '/payments/disputes',
  validate({ query: adminListDisputesQuerySchema }),
  controller.listDisputes,
)
rechargeAdminRoutes.post(
  '/payments/disputes/:id/resolve',
  validate({ params: adminUuidParamSchema, body: adminResolveDisputeSchema }),
  controller.resolveDispute,
)
rechargeAdminRoutes.post(
  '/payments/recovery-cases/:id/close',
  validate({ params: adminUuidParamSchema, body: adminCloseRecoveryCaseSchema }),
  controller.closeRecoveryCase,
)
