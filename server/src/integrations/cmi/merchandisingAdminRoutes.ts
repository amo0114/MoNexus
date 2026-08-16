import { Router } from 'express'
import { z } from 'zod'
import { HttpError, tooManyRequests } from '../../lib/httpError.js'
import { authenticate, requireActiveUser, requireAdmin, requireAdminMfa } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { listAdminRuns, requestManualRecompute } from '../../modules/merchandising/ranking/index.js'

const runListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict()

/**
 * CMI-owned thin HTTP adapter for ranking administration. Ranking algorithms,
 * cadence, locking and audit remain inside modules/merchandising/ranking.
 */
export const merchandisingAdminRouter = Router()

merchandisingAdminRouter.use(authenticate, requireActiveUser, requireAdmin, requireAdminMfa)

merchandisingAdminRouter.get(
  '/merchandising/runs',
  validate({ query: runListQuerySchema }),
  async (req, res, next) => {
    try {
      res.json(await listAdminRuns(req.query))
    } catch (err) {
      next(err)
    }
  },
)

merchandisingAdminRouter.post('/merchandising/recompute', async (req, res, next) => {
  try {
    const result = await requestManualRecompute(req.user!.userId)
    if (result.kind === 'skipped' && result.reason === 'cadence') {
      next(tooManyRequests('排名刚刚完成，请稍后再重算'))
      return
    }
    if (result.kind === 'skipped' && result.reason === 'compute_unavailable') {
      next(new HttpError(503, 'INTERNAL_SERVER_ERROR', '排名计算暂不可用'))
      return
    }
    res.json(result)
  } catch (err) {
    next(err)
  }
})
