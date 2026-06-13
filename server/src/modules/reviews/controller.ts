import type { Request, Response, NextFunction } from 'express'
import * as reviewService from './service.js'

export async function createForOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id as unknown as number
    const review = await reviewService.createOrderReview(req.user!.userId, orderId, req.body)
    res.status(201).json(review)
  } catch (err) {
    next(err)
  }
}

export async function updateForOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id as unknown as number
    const review = await reviewService.updateOrderReview(req.user!.userId, orderId, req.body)
    res.json(review)
  } catch (err) {
    next(err)
  }
}

export async function listForProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    const { page, pageSize } = req.query as unknown as { page: number; pageSize: number }
    res.json(await reviewService.listProductReviews(productId, page, pageSize))
  } catch (err) {
    next(err)
  }
}
