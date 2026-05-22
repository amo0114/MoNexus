import type { Request, Response, NextFunction } from 'express'
import { badRequest, unauthenticated } from '../../lib/httpError.js'
import * as dashboardService from './service.js'
import { TimeseriesQuerySchema } from './schemas.js'

export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.merchantId) throw unauthenticated('未登录')
    const merchantId = req.user.merchantId
    const result = await dashboardService.getSummary(merchantId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function timeseries(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = TimeseriesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      throw badRequest('range 参数无效，仅支持 7d / 30d / 90d')
    }

    if (!req.user?.merchantId) throw unauthenticated('未登录')
    const merchantId = req.user.merchantId
    const result = await dashboardService.getTimeseries(merchantId, parsed.data.range)
    res.json(result)
  } catch (err) {
    next(err)
  }
}
