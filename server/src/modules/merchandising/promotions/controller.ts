// T-MERCH-BE-003 — Promotion package/campaign controllers (SPEC-MERCH-001 §11).
// Thin express handlers: resolve merchantId (merchant lanes) / adminUserId,
// delegate to service, map HTTP status:
//   - create Campaign：首次 201、重放 200（§11）；
//   - 其余成功默认 200。
// No key/hash is ever echoed; the DTO allowlist in `dto.ts` is the single
// serialization boundary.

import { Request, Response, NextFunction } from 'express'
import * as promotionService from './service.js'
import * as billingService from './billing.js'
import type { ListCampaignsQuery } from './schema.js'

// ---- Merchant lanes ----

export async function listPackages(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await promotionService.listMerchantPackages())
  } catch (err) { next(err) }
}

export async function createCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await promotionService.resolveMerchantId(req.user!.userId)
    const result = await promotionService.createCampaign({
      merchantId,
      campaignInput: req.body,
      idempotencyKeyRaw: req.headers['idempotency-key'] as string | undefined,
    })
    // §11：首次 201、重放 200；都标 replayed。
    res.status(result.kind === 'created' ? 201 : 200).json({ campaign: result.campaign, replayed: result.kind === 'replayed' })
  } catch (err) { next(err) }
}

export async function listCampaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await promotionService.resolveMerchantId(req.user!.userId)
    res.json(await promotionService.listMerchantCampaigns(merchantId, req.query as unknown as ListCampaignsQuery))
  } catch (err) { next(err) }
}

export async function cancelCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await promotionService.resolveMerchantId(req.user!.userId)
    const campaignId = req.params.id as unknown as number
    const campaign = await promotionService.cancelMerchantCampaign(merchantId, req.user!.userId, campaignId, req.body)
    res.json({ campaign })
  } catch (err) { next(err) }
}

// ---- Admin lanes ----

export async function adminListPackages(req: Request, res: Response, next: NextFunction) {
  try {
    const query = (req.query ?? {}) as { includeInactive?: string | boolean }
    res.json(await promotionService.listAdminPackages({ includeInactive: query.includeInactive === true || query.includeInactive === 'true' }))
  } catch (err) { next(err) }
}

export async function adminCreatePackage(req: Request, res: Response, next: NextFunction) {
  try {
    const pkg = await promotionService.createPackage(req.user!.userId, req.body)
    res.status(201).json({ package: pkg })
  } catch (err) { next(err) }
}

export async function adminUpdatePackage(req: Request, res: Response, next: NextFunction) {
  try {
    const pkg = await promotionService.updatePackage(req.user!.userId, req.params.id as unknown as number, req.body)
    res.json({ package: pkg })
  } catch (err) { next(err) }
}

export async function adminListCampaigns(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await promotionService.listAdminCampaigns(req.query as unknown as ListCampaignsQuery))
  } catch (err) { next(err) }
}

export async function adminRejectCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const campaign = await promotionService.rejectCampaign(req.user!.userId, req.params.id as unknown as number, req.body)
    res.json({ campaign })
  } catch (err) { next(err) }
}

// ---------------------------------------------------------------------------
// T-MERCH-BE-004 — billing / lifecycle handlers（approve/retry/pause/resume/
// cancel/refund-adjustment）。薄 handler：读 header 的 Idempotency-Key 传给
// service；DTO allowlist 是唯一序列化边界（key/hash 永不返回）。
// ---------------------------------------------------------------------------

export async function merchantRetryPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = await promotionService.resolveMerchantId(req.user!.userId)
    const result = await billingService.retryCampaignPayment(merchantId, req.user!.userId, req.params.id as unknown as number)
    res.json({ campaign: result.campaign, replayed: false })
  } catch (err) { next(err) }
}

export async function adminApproveCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await billingService.approveCampaign(req.user!.userId, req.params.id as unknown as number)
    res.json({ campaign: result.campaign, replayed: false })
  } catch (err) { next(err) }
}

export async function adminPauseCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const campaign = await billingService.pauseCampaign(req.user!.userId, req.params.id as unknown as number)
    res.json({ campaign })
  } catch (err) { next(err) }
}

export async function adminResumeCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const campaign = await billingService.resumeCampaign(req.user!.userId, req.params.id as unknown as number)
    res.json({ campaign })
  } catch (err) { next(err) }
}

export async function adminCancelCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await billingService.adminCancelCampaign(
      req.user!.userId,
      req.params.id as unknown as number,
      req.body,
      req.headers['idempotency-key'] as string | undefined,
    )
    res.json({ campaign: result.campaign, replayed: result.replayed })
  } catch (err) { next(err) }
}

export async function adminRefundAdjustment(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await billingService.adjustCampaignRefund(
      req.user!.userId,
      req.params.id as unknown as number,
      req.body,
      req.headers['idempotency-key'] as string | undefined,
    )
    res.json({ campaign: result.campaign, replayed: result.replayed })
  } catch (err) { next(err) }
}
