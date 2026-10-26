import type { Request, Response, NextFunction } from 'express'
import { resolveProductAudience } from '../products/visibility.js'
import { listStorefrontCandidates } from './service.js'
import type { CandidatesQuery } from './schema.js'

export async function candidates(req: Request, res: Response, next: NextFunction) {
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await listStorefrontCandidates(req.query as CandidatesQuery, resolveProductAudience(req.user)))
  } catch (error) {
    next(error)
  }
}
