import * as offerService from './offerService.js'
import * as inventoryService from './inventoryService.js'
import * as productService from './productService.js'
import * as profileService from './profileService.js'
import * as dashboardQueries from './dashboardQueries.js'
import * as orderService from './orderService.js'
import { Request, Response, NextFunction } from 'express'
import * as webhookConfigService from './webhookConfig.js'
import type { MerchantOrderListQuery } from './schema.js'

// ---- Application ----

export async function apply(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.applyForMerchant(req.user!.userId, req.body)
    res.status(201).json(merchant)
  } catch (err) { next(err) }
}

// ---- Profile ----

export async function me(req: Request, res: Response, next: NextFunction) {
  try { res.json(await profileService.getMyMerchant(req.user!.userId)) } catch (err) { next(err) }
}

export async function updateMe(req: Request, res: Response, next: NextFunction) {
  try { res.json(await profileService.updateMyMerchant(req.user!.userId, req.body)) } catch (err) { next(err) }
}

// ---- Products ----

export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await productService.listMyProducts(merchant.id, req.query))
  } catch (err) { next(err) }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    if (req.body?.editorVersion === 2) {
      const { createProductFromV2 } = await import('../catalog/productWrite.js')
      res.status(201).json(await createProductFromV2({ kind: 'merchant', merchantId: merchant.id }, req.body))
      return
    }
    res.status(201).json(await productService.createMyProduct(merchant.id, req.body))
  } catch (err) { next(err) }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await productService.updateMyProduct(merchant.id, req.params.id as unknown as number, req.body))
  } catch (err) { next(err) }
}

export async function patchProductContent(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { patchProductContent } = await import('../catalog/productWrite.js')
    res.json(await patchProductContent(
      { kind: 'merchant', merchantId: merchant.id },
      req.params.id as unknown as number,
      req.body,
    ))
  } catch (err) { next(err) }
}

export async function getProductEditor(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { getProductEditor } = await import('../catalog/productWrite.js')
    res.json(await getProductEditor(
      { kind: 'merchant', merchantId: merchant.id },
      req.params.id as unknown as number,
    ))
  } catch (err) { next(err) }
}

export async function createContentSuggestion(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { generateContentSuggestion } = await import('../catalog/contentCopilot/service.js')
    res.json(await generateContentSuggestion(
      { kind: 'merchant', merchantId: merchant.id, userId: req.user!.userId },
      req.params.id as unknown as number,
      req.body,
    ))
  } catch (err) { next(err) }
}

export async function reportContentSuggestionApplied(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { recordContentSuggestionApplied } = await import('../catalog/contentCopilot/service.js')
    await recordContentSuggestionApplied(
      { kind: 'merchant', merchantId: merchant.id, userId: req.user!.userId },
      req.params.id as unknown as number,
      req.params.generationId as unknown as number,
      req.body.appliedFieldCount,
    )
    res.status(204).end()
  } catch (err) { next(err) }
}

export async function productReadiness(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    const result = await productService.getMyProductReadiness(merchant.id, productId)
    res.json({
      ready: result.ready,
      productId,
      issues: result.details.map(({ code, field, offerId }) => ({ code, field, offerId })),
    })
  } catch (err) { next(err) }
}

export async function publishProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const outcome = await productService.publishMyProduct(merchant.id, req.params.id as unknown as number)
    res.json({ id: outcome.product.id, status: outcome.product.status, publishedAt: outcome.product.publishedAt })
  } catch (err) { next(err) }
}

export async function unpublishProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const outcome = await productService.unpublishMyProduct(merchant.id, req.params.id as unknown as number)
    res.json({ id: outcome.product.id, status: outcome.product.status, publishedAt: outcome.product.publishedAt })
  } catch (err) { next(err) }
}

export async function adjustProductCapacity(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    res.json(await inventoryService.adjustMyProductCapacity(merchant.id, req.user!.userId, productId, req.body))
  } catch (err) { next(err) }
}

export async function previewInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    res.json(await inventoryService.previewMyInventoryImport(merchant.id, productId, req.body))
  } catch (err) { next(err) }
}

export async function importInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    res.json(await inventoryService.importMyInventory(merchant.id, req.user!.userId, productId, req.body))
  } catch (err) { next(err) }
}

export async function voidInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    res.json(await inventoryService.voidMyInventory(merchant.id, req.user!.userId, productId, req.body))
  } catch (err) { next(err) }
}

export async function listInventoryLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    const { page, pageSize } = req.query as unknown as { page?: number; pageSize?: number }
    res.json(await inventoryService.listMyInventoryLogs(merchant.id, productId, { page, pageSize }))
  } catch (err) { next(err) }
}

// ---- T-CAT-BE-004：新 Offer-first 路径（offerId 显式在 URL，D-CAT-12/13）----

export async function previewOfferInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await inventoryService.previewMyOfferInventory(merchant.id, id, offerId, req.body))
  } catch (err) { next(err) }
}

export async function importOfferInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await inventoryService.importMyOfferInventory(merchant.id, req.user!.userId, id, offerId, req.body))
  } catch (err) { next(err) }
}

export async function voidOfferInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await inventoryService.voidMyOfferInventory(merchant.id, req.user!.userId, id, offerId, req.body))
  } catch (err) { next(err) }
}

export async function adjustOfferCapacity(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await inventoryService.adjustMyOfferCapacity(merchant.id, req.user!.userId, id, offerId, req.body))
  } catch (err) { next(err) }
}
// ---- Orders ----

type OrderWithSettlement = {
  settlement?: { settlementAmount: number; status: string; settledAt: Date | null } | null
  [key: string]: unknown
}

function flattenSettlement<T extends OrderWithSettlement>(order: T) {
  return {
    ...order,
    settlementAmount: order.settlement?.settlementAmount ?? 0,
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const orders = await orderService.listMyOrders(
      merchant.id,
      req.query as unknown as MerchantOrderListQuery
    )
    res.json({
      ...orders,
      items: orders.items.map(flattenSettlement),
    })
  } catch (err) { next(err) }
}

export async function orderDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const order = await orderService.getMyOrderDetail(merchant.id, req.params.id as unknown as number)
    res.json(flattenSettlement(order))
  } catch (err) { next(err) }
}

export async function startFulfillment(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const order = await orderService.startOrderFulfillment(
      merchant.id,
      req.user!.userId,
      req.params.id as unknown as number,
      req.body
    )
    res.json(flattenSettlement(order))
  } catch (err) { next(err) }
}

export async function deliverFulfillment(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const order = await orderService.deliverOrderFulfillment(
      merchant.id,
      req.user!.userId,
      req.params.id as unknown as number,
      req.body
    )
    res.json(flattenSettlement(order))
  } catch (err) { next(err) }
}

export async function postProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await orderService.postOrderProgress(
      merchant.id,
      req.user!.userId,
      req.params.id as unknown as number,
      req.body
    ))
  } catch (err) { next(err) }
}

export async function respondDispute(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const order = await orderService.respondToOrderDispute(
      merchant.id,
      req.user!.userId,
      req.params.id as unknown as number,
      req.body
    )
    res.json(flattenSettlement(order))
  } catch (err) { next(err) }
}

export async function rejectOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const order = await orderService.rejectOrder(
      merchant.id,
      req.user!.userId,
      req.params.id as unknown as number,
      req.body
    )
    res.json(flattenSettlement(order))
  } catch (err) { next(err) }
}

// ---- Settlements ----

export async function listSettlements(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    const { page, pageSize } = req.query as Record<string, string>
    res.json(await dashboardQueries.listMySettlements(merchant.id, Number(page) || 1, Number(pageSize) || 20))
  } catch (err) { next(err) }
}

// ---- Stats ----

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await dashboardQueries.getMyStats(merchant.id))
  } catch (err) { next(err) }
}

// ---- Offers (P4a) ----

export async function listOffers(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await offerService.listMyOffers(merchant.id, req.params.id as unknown as number))
  } catch (err) { next(err) }
}

export async function createOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.status(201).json(await offerService.createMyOffer(merchant.id, req.params.id as unknown as number, req.body))
  } catch (err) { next(err) }
}

export async function updateOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await offerService.updateMyOffer(
      merchant.id,
      req.params.id as unknown as number,
      req.params.offerId as unknown as number,
      req.body
    ))
  } catch (err) { next(err) }
}

export async function deleteOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await offerService.deleteMyOffer(
      merchant.id,
      req.params.id as unknown as number,
      req.params.offerId as unknown as number
    ))
  } catch (err) { next(err) }
}

// ---- Webhook 配置（P7b 自动开通）----

export async function getWebhookConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await webhookConfigService.getMyWebhookConfig(merchant.id))
  } catch (err) { next(err) }
}

export async function saveWebhookConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await webhookConfigService.saveMyWebhookConfig(merchant.id, req.body.url))
  } catch (err) { next(err) }
}

export async function revokeWebhookConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await webhookConfigService.revokeMyWebhookConfig(merchant.id))
  } catch (err) { next(err) }
}

export async function testWebhookConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await profileService.getMyMerchant(req.user!.userId)
    res.json(await webhookConfigService.sendTestWebhookEvent(merchant.id))
  } catch (err) { next(err) }
}
