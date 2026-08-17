import { Request, Response, NextFunction } from 'express'
import * as valuePolicyService from './service.js'

export async function current(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await valuePolicyService.getCurrentValuePolicy())
  } catch (err) {
    next(err)
  }
}
