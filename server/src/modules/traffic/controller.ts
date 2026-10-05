import type { Request, Response, NextFunction } from 'express'
import { unauthenticated } from '../../lib/httpError.js'
import { resolveProductAudience } from '../products/visibility.js'
import type { TrafficRange } from './schema.js'
import { getTrafficReport, recordTrafficEvent } from './service.js'

export async function collect(req: Request, res: Response, next: NextFunction) {
  try {
    await recordTrafficEvent(req.body, resolveProductAudience(req.user))
    res.status(204).end()
  } catch (err) { next(err) }
}

export async function merchantReport(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.merchantId) throw unauthenticated('未登录')
    const range = req.query.range as TrafficRange
    res.set('Cache-Control', 'private, no-store').json(await getTrafficReport(range, req.user.merchantId))
  } catch (err) { next(err) }
}

export async function platformReport(req: Request, res: Response, next: NextFunction) {
  try {
    const range = req.query.range as TrafficRange
    res.set('Cache-Control', 'private, no-store').json(await getTrafficReport(range))
  } catch (err) { next(err) }
}
