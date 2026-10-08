import { Router } from 'express'
import { AiTaskCancelledError } from '../../../lib/ai/task.js'
import { validate } from '../../../middlewares/validate.js'
import { emptyQuery } from '../workbench/schema.js'
import { turnSchema } from './schema.js'
import { getAgentAvailability, runAgentTurnRequest } from './service.js'

// Mounted AFTER authenticate/requireActiveUser/requireMerchant (SPEC-MERCHANT-AGENT-001 §8.1).
export const agentRoutes = Router()
agentRoutes.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

agentRoutes.get('/availability', validate({ query: emptyQuery }), async (req, res, next) => {
  try { res.json(await getAgentAvailability(req.user!)) } catch (err) { next(err) }
})

agentRoutes.post('/turns', validate(turnSchema), async (req, res, next) => {
  // §6.4: only a real client disconnect cancels the run. A request 'close'
  // after the body was fully read, or a 'close' after the response finished,
  // is not a cancellation.
  const controller = new AbortController()
  const onResponseClose = () => { if (!res.writableFinished) controller.abort() }
  const onRequestAborted = () => controller.abort()
  res.on('close', onResponseClose)
  req.on('aborted', onRequestAborted)
  try {
    const result = await runAgentTurnRequest(req.user!, req.body, controller.signal)
    if (!controller.signal.aborted) res.json(result)
  } catch (err) {
    if (err instanceof AiTaskCancelledError || controller.signal.aborted) return
    next(err)
  } finally {
    res.off('close', onResponseClose)
    req.off('aborted', onRequestAborted)
  }
})
