import { Request, Response, NextFunction } from 'express'
import * as checkoutService from './service.js'
import type { z } from 'zod'
import type { previewQuerySchema } from './routes.js'

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, offerId, xboardAccountLinkId, extensionInput } = req.query as unknown as z.infer<typeof previewQuerySchema>
    const result = await checkoutService.getCheckoutPreview(req.user!.userId, productId, offerId,
      { ...extensionInput, ...(xboardAccountLinkId ? { xboardAccountLinkId } : {}) })
    res.setHeader('Cache-Control', 'no-store')
    res.json(result)
  } catch (err) {
    next(err)
  }
}
