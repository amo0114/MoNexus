import { Request, Response, NextFunction } from 'express'
import * as orderService from './service.js'

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await orderService.createOrder(req.user!.userId, req.body.productId)
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const orders = await orderService.getUserOrders(req.user!.userId)
    res.json(orders)
  } catch (err) {
    next(err)
  }
}
