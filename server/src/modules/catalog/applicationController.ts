// T-CAT-BE-002 — CategoryApplication API controllers (SPEC-CATALOG-OPS-001
// §7.3; REQ-CAT-F-008; CHK-CAT-006~009).
//
// Thin Express adapters over applicationService. Merchant routes resolve the
// caller's merchantId through the existing merchant ownership boundary
// (getMyMerchant) — it is never read from the request body. Admin routes use
// the authenticated admin userId (the mounted admin router already enforced
// authenticate → active → admin → MFA).

import { Request, Response, NextFunction } from 'express'
import * as applicationService from './applicationService.js'
import { getMyMerchant } from '../merchant/service.js'
import type {
  ApproveCategoryApplicationInput,
  CreateCategoryApplicationInput,
  ListAdminCategoryApplicationsQuery,
  ListMyCategoryApplicationsQuery,
  RejectCategoryApplicationInput,
} from './applicationSchema.js'

/** Ownership resolution: derive the active merchant id from the authenticated user. */
async function resolveMerchantId(req: Request): Promise<number> {
  const merchant = await getMyMerchant(req.user!.userId)
  return merchant.id
}

// ─────────────────────────── Merchant ───────────────────────────

export async function merchantList(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await resolveMerchantId(req)
    res.json(await applicationService.listMyCategoryApplications(
      merchantId,
      req.query as unknown as ListMyCategoryApplicationsQuery,
    ))
  } catch (err) {
    next(err)
  }
}

export async function merchantCreate(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await resolveMerchantId(req)
    res.status(201).json(await applicationService.createMyCategoryApplication(
      merchantId,
      req.body as CreateCategoryApplicationInput,
    ))
  } catch (err) {
    next(err)
  }
}

export async function merchantWithdraw(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await resolveMerchantId(req)
    const applicationId = req.params.id as unknown as number
    res.json(await applicationService.withdrawMyCategoryApplication(merchantId, applicationId))
  } catch (err) {
    next(err)
  }
}

// ─────────────────────────── Admin ───────────────────────────

export async function adminList(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await applicationService.listAdminCategoryApplications(
      req.query as unknown as ListAdminCategoryApplicationsQuery,
    ))
  } catch (err) {
    next(err)
  }
}

export async function adminApprove(req: Request, res: Response, next: NextFunction) {
  try {
    const applicationId = req.params.id as unknown as number
    res.json(await applicationService.approveCategoryApplication(
      req.user!.userId,
      applicationId,
      req.body as ApproveCategoryApplicationInput,
    ))
  } catch (err) {
    next(err)
  }
}

export async function adminReject(req: Request, res: Response, next: NextFunction) {
  try {
    const applicationId = req.params.id as unknown as number
    res.json(await applicationService.rejectCategoryApplication(
      req.user!.userId,
      applicationId,
      req.body as RejectCategoryApplicationInput,
    ))
  } catch (err) {
    next(err)
  }
}
