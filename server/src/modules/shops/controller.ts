import { Request, Response, NextFunction } from 'express'
import { resolveProductAudience } from '../products/visibility.js'
import { listShopProducts } from './service.js'

export async function products(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantId } = req.params as unknown as { merchantId: number }
    const { q, cursor } = req.query as { q?: string; cursor?: string }
    res.json(await listShopProducts(merchantId, {
      query: q,
      cursor,
      audience: resolveProductAudience(req.user),
    }))
  } catch (err) {
    next(err)
  }
}
