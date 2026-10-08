import { Router } from 'express'
import { validate } from '../../../middlewares/validate.js'
import type { AiActorRole } from '../../../lib/ai/generation.js'
import { draftSuggestionRequestSchema } from './schema.js'
import { generateDraftSuggestion, isDraftAssistantAvailable } from './service.js'

/** Mounted only after the parent admin MFA / active merchant authorization chain. */
export function createDraftAssistantRouter(role: AiActorRole) {
  const router = Router()
  router.get('/products/draft-assistant', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json({ available: await isDraftAssistantAvailable(role) })
    } catch (err) { next(err) }
  })
  router.post('/products/draft-suggestions', validate(draftSuggestionRequestSchema), async (req, res, next) => {
    try {
      const result = await generateDraftSuggestion({ userId: req.user!.userId, role }, req.body.description)
      res.set('Cache-Control', 'no-store').json(result)
    } catch (err) { next(err) }
  })
  return router
}
