import { Request, Response, NextFunction } from 'express'
import * as productService from './service.js'
import { resolveProductAudience } from './visibility.js'

function noStore(res: Response) {
  res.set('Cache-Control', 'private, no-store')
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, categoryCode, category, cursor, page, pageSize } = req.query as unknown as {
      q?: string
      categoryCode?: string
      category?: string
      cursor?: string
      page?: number
      pageSize?: number
    }
    const products = await productService.listProducts({
      query: q,
      categoryCode,
      category,
      cursor,
      page,
      pageSize,
      audience: resolveProductAudience(req.user),
    })
    noStore(res)
    res.json(products)
  } catch (err) {
    next(err)
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    const product = await productService.getProductDetail(id, resolveProductAudience(req.user))
    noStore(res)
    res.json(product)
  } catch (err) {
    next(err)
  }
}
