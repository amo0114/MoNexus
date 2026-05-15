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
    const { page, pageSize, status } = req.query as { page?: number; pageSize?: number; status?: string }
    const orders = await orderService.getUserOrders(
      req.user!.userId,
      Number(page) || 1,
      Number(pageSize) || 20,
      status
    )
    res.json(orders)
  } catch (err) {
    next(err)
  }
}

export async function dispute(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.disputeOrder(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(order)
  } catch (err) {
    next(err)
  }
}

export async function close(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.closeOrder(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(order)
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
