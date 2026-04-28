import { Request, Response, NextFunction } from 'express'
import * as productService from './service.js'

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, category } = req.query
    const products = await productService.listProducts(
      q as string | undefined,
      category as string | undefined
    )
    res.json(products)
  } catch (err) {
    next(err)
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    const product = await productService.getProductDetail(id)
    res.json(product)
  } catch (err) {
    next(err)
  }
}
