import { Router } from 'express'
import { authenticate, requireActiveUser, requireAdmin, requireAdminMfa, requireMerchant } from '../../../middlewares/auth.js'
import { idParamSchema, validate } from '../../../middlewares/validate.js'
import { resolveMerchantId } from '../promotions/service.js'
import { listEntitlementsQuerySchema, manualGrantEntitlementSchema, revokeEntitlementSchema } from './schema.js'
import {
  listAdminEntitlements,
  listMerchantEntitlements,
  manualGrantPartnerEntitlement,
  revokePartnerEntitlement,
} from './service.js'

export const merchantEntitlementRouter = Router()
merchantEntitlementRouter.use(authenticate, requireActiveUser, requireMerchant)
merchantEntitlementRouter.get('/entitlements', async (req, res, next) => {
  try {
    const merchantId = await resolveMerchantId(req.user!.userId)
    res.json({ items: await listMerchantEntitlements(merchantId) })
  } catch (err) { next(err) }
})

export const adminEntitlementRouter = Router()
adminEntitlementRouter.use(authenticate, requireActiveUser, requireAdmin, requireAdminMfa)
adminEntitlementRouter.get('/merchant-entitlements', validate({ query: listEntitlementsQuerySchema }), async (req, res, next) => {
  try { res.json(await listAdminEntitlements(req.query)) } catch (err) { next(err) }
})
adminEntitlementRouter.post('/merchant-entitlements', validate(manualGrantEntitlementSchema), async (req, res, next) => {
  try { res.status(201).json(await manualGrantPartnerEntitlement(req.user!.userId, req.body)) } catch (err) { next(err) }
})
adminEntitlementRouter.post('/merchant-entitlements/:id/revoke', validate({ params: idParamSchema, body: revokeEntitlementSchema }), async (req, res, next) => {
  try { res.json(await revokePartnerEntitlement(req.user!.userId, req.params.id as unknown as number, req.body.reason)) } catch (err) { next(err) }
})

