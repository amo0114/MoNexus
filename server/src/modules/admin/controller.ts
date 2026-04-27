import { Request, Response, NextFunction } from 'express'
import * as adminService from './service.js'

export async function stats(req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.getStats()) } catch (err) { next(err) }
}

export async function users(req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listUsers(req.query.q as string)) } catch (err) { next(err) }
}

export async function adjustPoints(req: Request, res: Response, next: NextFunction) {
  try {
    const targetId = parseInt(req.params.id)
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
    const id = parseInt(req.params.id)
    res.json(await adminService.updateProduct(id, req.body))
  } catch (err) { next(err) }
}

export async function importInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = parseInt(req.params.id)
    const result = await adminService.importInventory(productId, req.body.items, req.user!.userId)
    res.json(result)
  } catch (err) { next(err) }
}

export async function orders(req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listAllOrders()) } catch (err) { next(err) }
}

export async function logs(req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listLogs()) } catch (err) { next(err) }
}

export async function products(req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listAdminProducts()) } catch (err) { next(err) }
}
