import { Request, Response, NextFunction } from 'express'
import * as adminService from './service.js'

export async function stats(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.getStats()) } catch (err) { next(err) }
}

export async function users(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, page, pageSize } = req.query as Record<string, string>
    res.json(await adminService.listUsers(q, Number(page) || 1, Number(pageSize) || 20))
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

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try { res.status(201).json(await adminService.createProduct(req.body)) } catch (err) { next(err) }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await adminService.updateProduct(id, req.body))
  } catch (err) { next(err) }
}

export async function importInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    const result = await adminService.importInventory(productId, req.body.items, req.user!.userId)
    res.json(result)
  } catch (err) { next(err) }
}

export async function orders(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, pageSize } = req.query as Record<string, string>
    res.json(await adminService.listAllOrders(Number(page) || 1, Number(pageSize) || 20))
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

export async function products(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listAdminProducts()) } catch (err) { next(err) }
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
