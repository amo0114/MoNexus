import { Request, Response, NextFunction } from 'express'
import * as merchantService from './service.js'

// ---- Application ----

export async function apply(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.applyForMerchant(req.user!.userId, req.body)
    res.status(201).json(merchant)
  } catch (err) { next(err) }
}

// ---- Profile ----

export async function me(req: Request, res: Response, next: NextFunction) {
  try { res.json(await merchantService.getMyMerchant(req.user!.userId)) } catch (err) { next(err) }
}

export async function updateMe(req: Request, res: Response, next: NextFunction) {
  try { res.json(await merchantService.updateMyMerchant(req.user!.userId, req.body)) } catch (err) { next(err) }
}

// ---- Products ----

export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    const { page, pageSize } = req.query as Record<string, string>
    res.json(await merchantService.listMyProducts(merchant.id, Number(page) || 1, Number(pageSize) || 20))
  } catch (err) { next(err) }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    res.status(201).json(await merchantService.createMyProduct(merchant.id, req.body))
  } catch (err) { next(err) }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    res.json(await merchantService.updateMyProduct(merchant.id, req.params.id as unknown as number, req.body))
  } catch (err) { next(err) }
}

export async function importInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    const productId = req.params.id as unknown as number
    res.json(await merchantService.importMyInventory(merchant.id, productId, req.body.items))
  } catch (err) { next(err) }
}

// ---- Orders ----

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    const { page, pageSize } = req.query as Record<string, string>
    res.json(await merchantService.listMyOrders(merchant.id, Number(page) || 1, Number(pageSize) || 20))
  } catch (err) { next(err) }
}

export async function orderDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    res.json(await merchantService.getMyOrderDetail(merchant.id, req.params.id as unknown as number))
  } catch (err) { next(err) }
}

// ---- Settlements ----

export async function listSettlements(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    const { page, pageSize } = req.query as Record<string, string>
    res.json(await merchantService.listMySettlements(merchant.id, Number(page) || 1, Number(pageSize) || 20))
  } catch (err) { next(err) }
}

// ---- Stats ----

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await merchantService.getMyMerchant(req.user!.userId)
    res.json(await merchantService.getMyStats(merchant.id))
  } catch (err) { next(err) }
}
