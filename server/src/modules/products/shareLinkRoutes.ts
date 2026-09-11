import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'
import { idParamSchema, validate } from '../../middlewares/validate.js'
import { resolveProductAudience } from './visibility.js'
import { createProductShareLink } from './shareLinks.js'

const emptyBodySchema = z.object({}).strict()

function noStore(res: Response) {
  res.set('Cache-Control', 'private, no-store')
}

export const shareLinkRoutes = Router()

shareLinkRoutes.post(
  '/:id/share-link',
  authenticateIfPresent,
  requireActiveUserIfPresent,
  validate({ params: idParamSchema, body: emptyBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as unknown as number
      const result = await createProductShareLink(id, resolveProductAudience(req.user))
      noStore(res)
      res.json(result)
    } catch (err) {
      next(err)
    }
  },
)
