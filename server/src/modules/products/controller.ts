import { Request, Response, NextFunction } from 'express'
import * as productService from './service.js'
import { resolveProductAudience } from './visibility.js'

function noStore(res: Response) {
  res.set('Cache-Control', 'private, no-store')
}

/** Route-level so auth/validation error responses are not cacheable either. */
export function noStoreHeaders(_req: Request, res: Response, next: NextFunction) {
  noStore(res)
  next()
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

export async function recommendations(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await productService.getProductRecommendations(id, resolveProductAudience(req.user)))
  } catch (err) {
    next(err)
  }
}

export async function summaries(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await productService.getProductSummaries(
      (req.query as unknown as { ids: number[] }).ids, resolveProductAudience(req.user),
    ))
  } catch (error) { next(error) }
}
