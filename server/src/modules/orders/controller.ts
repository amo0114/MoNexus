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
    const { page, pageSize } = req.query as Record<string, string>
    const orders = await orderService.getUserOrders(
      req.user!.userId,
      Number(page) || 1,
      Number(pageSize) || 20
    )
    res.json(orders)
  } catch (err) {
    next(err)
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.getOrderDetail(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(order)
  } catch (err) {
    next(err)
  }
}
