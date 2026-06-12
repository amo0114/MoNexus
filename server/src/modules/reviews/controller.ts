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
