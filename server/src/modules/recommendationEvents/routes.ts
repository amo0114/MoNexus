import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { eventBatchSchema, type ReportQuery } from './schema.js'
import { recordRecommendationEvents } from './service.js'
import { getRecommendationReport } from './report.js'

export const recommendationEventRoutes = Router()
recommendationEventRoutes.post('/events', authenticateIfPresent, requireActiveUserIfPresent, validate(eventBatchSchema),
  async (req, res, next) => {
    try { await recordRecommendationEvents(req.body, req.user?.userId); res.status(204).end() } catch (err) { next(err) }
  })

// Mounted on the existing admin router, after its authentication/admin/MFA guards.
export async function recommendationReport(req: Request, res: Response, next: NextFunction) {
  try {
    res.set('Cache-Control', 'private, no-store').json(await getRecommendationReport(req.query as ReportQuery))
  } catch (err) { next(err) }
}
