import { Request, Response, NextFunction } from 'express'
import * as adminService from './service.js'
import * as mailOperations from './mailOperations.js'
import * as reviewService from '../reviews/service.js'
import type {
  ListAdminAuditQuery, ListAnnouncementsQuery, ListOrdersQuery, ListUsersQuery,
  ListDeliveryFilesQuery, ListFileGrantsQuery, OfferReportQuery,
  MailDeliveryTestInput,
} from './schema.js'

export async function stats(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.getStats()) } catch (err) { next(err) }
}

export async function users(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listUsers(req.query as unknown as ListUsersQuery))
  } catch (err) { next(err) }
}

export async function adjustPoints(req: Request, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id as unknown as number
    const { type, amount, reason } = req.body
    const result = await adminService.adjustUserPoints(req.user!.userId, targetId, type, amount, reason)
    res.json(result)
  } catch (err) { next(err) }
}

export async function banUser(req: Request, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id as unknown as number
    res.json(await adminService.banUser(req.user!.userId, targetId, req.body.reason))
  } catch (err) { next(err) }
}

export async function unbanUser(req: Request, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id as unknown as number
    res.json(await adminService.unbanUser(req.user!.userId, targetId))
  } catch (err) { next(err) }
}

export async function listConfig(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listSystemConfig())
  } catch (err) { next(err) }
}

export async function updateConfig(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.updateSystemConfig(req.user!.userId, String(req.params.key), req.body.value))
  } catch (err) { next(err) }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try { res.status(201).json(await adminService.createProduct(req.user!.userId, req.body)) } catch (err) { next(err) }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await adminService.updateProduct(req.user!.userId, id, req.body))
  } catch (err) { next(err) }
}

export async function productReadiness(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    const result = await adminService.getProductReadiness(productId)
    res.json({
      ready: result.ready,
      productId,
      issues: result.details.map(({ code, field, offerId }) => ({ code, field, offerId })),
    })
  } catch (err) { next(err) }
}

export async function publishProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const outcome = await adminService.publishProduct(req.params.id as unknown as number)
    res.json({ id: outcome.product.id, status: outcome.product.status, publishedAt: outcome.product.publishedAt })
  } catch (err) { next(err) }
}

export async function unpublishProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const outcome = await adminService.unpublishProduct(req.params.id as unknown as number)
    res.json({ id: outcome.product.id, status: outcome.product.status, publishedAt: outcome.product.publishedAt })
  } catch (err) { next(err) }
}

export async function importInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    const result = await adminService.importInventory(productId, req.body, req.user!.userId)
    res.json(result)
  } catch (err) { next(err) }
}

// T-CAT-BE-004（D-CAT-13/15）：admin preview → confirm，与商家共用领域分析器。
export async function previewInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.previewInventory(productId, req.body))
  } catch (err) { next(err) }
}

export async function previewOfferInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.previewOfferInventory(id, offerId, req.body))
  } catch (err) { next(err) }
}

export async function importOfferInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.importOfferInventory(id, offerId, req.body, req.user!.userId))
  } catch (err) { next(err) }
}

export async function orders(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listAllOrders(req.query as unknown as ListOrdersQuery))
  } catch (err) { next(err) }
}

export async function orderDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await adminService.getOrderDetail(id))
  } catch (err) { next(err) }
}

export async function logs(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listLogs()) } catch (err) { next(err) }
}

export async function audit(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listAdminLogs(req.query as unknown as ListAdminAuditQuery))
  } catch (err) { next(err) }
}

export async function products(req: Request, res: Response, next: NextFunction) {
  try {
    const archived = (req.query.archived as 'exclude' | 'only' | 'all' | undefined) ?? 'exclude'
    res.json(await adminService.listAdminProducts(archived))
  } catch (err) { next(err) }
}

export async function archiveProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.archiveAdminProduct(req.user!.userId, productId, {
      reason: req.body?.reason,
    }))
  } catch (err) { next(err) }
}

export async function restoreProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.restoreAdminProduct(req.user!.userId, productId))
  } catch (err) { next(err) }
}

export async function purgeProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.purgeAdminProduct(req.user!.userId, productId))
  } catch (err) { next(err) }
}

export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.deleteAdminProduct(req.user!.userId, productId))
  } catch (err) {
    next(err)
  }
}

export async function patchOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.patchAdminOffer(req.user!.userId, id, offerId, req.body))
  } catch (err) { next(err) }
}

export async function archiveOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.archiveAdminOffer(req.user!.userId, id, offerId))
  } catch (err) { next(err) }
}

export async function restoreOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.restoreAdminOffer(req.user!.userId, id, offerId))
  } catch (err) { next(err) }
}

export async function makeDefaultOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.makeDefaultAdminOffer(req.user!.userId, id, offerId))
  } catch (err) { next(err) }
}

export async function previewRebindOfferSku(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await adminService.previewRebindAdminOfferSku(id, offerId, req.body.sku))
  } catch (err) { next(err) }
}

export async function rebindOfferSku(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    if (!req.body.sourceHash) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: '重绑 SKU 需要 sourceHash' } })
      return
    }
    res.json(await adminService.rebindAdminOfferSku(req.user!.userId, id, offerId, {
      sku: req.body.sku,
      sourceHash: req.body.sourceHash,
    }))
  } catch (err) { next(err) }
}

export async function previewFakaSync(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.previewAdminFakaSync(productId))
  } catch (err) { next(err) }
}

export async function confirmFakaSync(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await adminService.confirmAdminFakaSync(
      req.user!.userId,
      productId,
      req.body,
      req.headers['idempotency-key'] as string | undefined,
    ))
  } catch (err) { next(err) }
}

export async function setFakaCapacity(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(
      await adminService.setAdminFakaCapacity(req.user!.userId, productId, {
        offerId: req.body.offerId,
        capacityLimit: req.body.capacityLimit,
      })
    )
  } catch (err) {
    next(err)
  }
}

export async function fakaCatalog(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listAdminFakaCatalog())
  } catch (err) {
    next(err)
  }
}

export async function importFakaPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await adminService.importAdminFakaPlan(
      req.user!.userId,
      req.body,
      req.headers['idempotency-key'] as string | undefined,
    )
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (err) {
    next(err)
  }
}

export async function previewFakaPlan(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.previewAdminFakaPlan(req.body))
  } catch (err) {
    next(err)
  }
}

export async function addFakaOffers(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.status(201).json(
      await adminService.addAdminFakaOffers(req.user!.userId, productId, {
        offers: req.body.offers,
      })
    )
  } catch (err) {
    next(err)
  }
}

export async function listFakaTasks(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listFakaBridgeTasks(req.query as any))
  } catch (err) {
    next(err)
  }
}

export async function fakaTaskStats(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.getFakaBridgeTaskStats())
  } catch (err) {
    next(err)
  }
}

export async function retryFakaTask(req: Request, res: Response, next: NextFunction) {
  try {
    const taskId = req.params.id as unknown as number
    res.json(await adminService.retryFakaBridgeTask(req.user!.userId, taskId))
  } catch (err) {
    next(err)
  }
}

export async function forceFakaRevoke(req: Request, res: Response, next: NextFunction) {
  try {
    const taskId = req.params.id as unknown as number
    res.json(await adminService.forceFakaBridgeRevoke(req.user!.userId, taskId))
  } catch (err) {
    next(err)
  }
}

// ---- Merchants ----

export async function listMerchants(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, q, page, pageSize } = req.query as Record<string, string>
    res.json(await adminService.listMerchants(status, q, Number(page) || 1, Number(pageSize) || 20))
  } catch (err) { next(err) }
}

export async function merchantDetail(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.getMerchantDetail(req.params.id as unknown as number))
  } catch (err) { next(err) }
}

export async function approveMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.approveMerchant(req.user!.userId, req.params.id as unknown as number))
  } catch (err) { next(err) }
}

export async function rejectMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.rejectMerchant(req.user!.userId, req.params.id as unknown as number, req.body.reason))
  } catch (err) { next(err) }
}

export async function suspendMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.suspendMerchant(req.user!.userId, req.params.id as unknown as number))
  } catch (err) { next(err) }
}

export async function updateCommission(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.updateCommission(req.user!.userId, req.params.id as unknown as number, req.body.commissionRate))
  } catch (err) { next(err) }
}

// ---- Reviews ----

export async function listReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, page, pageSize } = req.query as unknown as { productId?: number; page: number; pageSize: number }
    res.json(await reviewService.listReviewsForAdmin({ productId, page, pageSize }))
  } catch (err) { next(err) }
}

export async function removeReview(req: Request, res: Response, next: NextFunction) {
  try {
    const reviewId = req.params.id as unknown as number
    res.json(await reviewService.removeReviewByAdmin(req.user!.userId, reviewId))
  } catch (err) { next(err) }
}

// ---- Settlements ----

export async function listSettlements(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, page, pageSize } = req.query as Record<string, string>
    res.json(await adminService.listAllSettlements(status, Number(page) || 1, Number(pageSize) || 20))
  } catch (err) { next(err) }
}

export async function batchSettle(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.batchSettle(req.user!.userId, req.body.settlementIds))
  } catch (err) { next(err) }
}

// ---- Order Arbitration ----

export async function resolveOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id as unknown as number
    res.json(await adminService.resolveOrder(req.user!.userId, orderId, req.body))
  } catch (err) { next(err) }
}

// ---- Announcements ----

export async function listAnnouncementsRoute(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listAnnouncements(req.query as unknown as ListAnnouncementsQuery))
  } catch (err) { next(err) }
}

export async function createAnnouncementRoute(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await adminService.createAnnouncement(req.user!.userId, req.body))
  } catch (err) { next(err) }
}

export async function updateAnnouncementRoute(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await adminService.updateAnnouncement(req.user!.userId, id, req.body))
  } catch (err) { next(err) }
}

export async function deleteAnnouncementRoute(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await adminService.deleteAnnouncement(req.user!.userId, id))
  } catch (err) { next(err) }
}

// P5：吊销交付文件。
export async function revokeDeliveryFile(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.revokeDeliveryFile(
      req.user!.userId,
      req.params.id as unknown as number,
      (req.body as { reason?: string }).reason,
    ))
  } catch (err) { next(err) }
}

// ---- P5.5：文件治理与规格报表 ----

export async function listDeliveryFiles(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.listDeliveryFiles(req.query as unknown as ListDeliveryFilesQuery))
  } catch (err) { next(err) }
}

export async function deliveryFileGrants(req: Request, res: Response, next: NextFunction) {
  try {
    const fileId = req.params.id as unknown as number
    res.json(await adminService.listDeliveryFileGrants(fileId, req.query as unknown as ListFileGrantsQuery))
  } catch (err) { next(err) }
}

export async function offerReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { range } = req.query as unknown as OfferReportQuery
    res.json(await adminService.getOfferReport(range))
  } catch (err) { next(err) }
}

// ---- SPEC-OPS-REGMAIL-001：邮件投递运营面 ----

export function mailStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(mailOperations.getMailDeliveryStatus())
  } catch (err) { next(err) }
}

export async function mailTest(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body as MailDeliveryTestInput
    res.json(await mailOperations.sendMailDeliveryTest({ adminUserId: req.user!.userId, email }))
  } catch (err) { next(err) }
}
