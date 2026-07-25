import { Request, Response, NextFunction } from 'express'
import * as checkoutService from './service.js'

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId } = req.query as unknown as { productId: number }
    const result = await checkoutService.getCheckoutPreview(req.user!.userId, productId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}
