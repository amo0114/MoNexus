import { Request, Response, NextFunction } from 'express'
import * as checkoutService from './service.js'

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, offerId } = req.query as unknown as { productId: number; offerId?: number }
    const result = await checkoutService.getCheckoutPreview(req.user!.userId, productId, offerId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}
