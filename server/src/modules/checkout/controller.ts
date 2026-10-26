import { Request, Response, NextFunction } from 'express'
import * as checkoutService from './service.js'

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, offerId, xboardAccountLinkId } = req.query as unknown as { productId: number; offerId?: number; xboardAccountLinkId?: string }
    const result = await checkoutService.getCheckoutPreview(req.user!.userId, productId, offerId, xboardAccountLinkId)
    res.setHeader('Cache-Control', 'no-store')
    res.json(result)
  } catch (err) {
    next(err)
  }
}
