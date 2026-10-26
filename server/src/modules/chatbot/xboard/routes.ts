import { Router, raw, type ErrorRequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { validate } from '../../../middlewares/validate.js'
import { HttpError } from '../../../lib/httpError.js'
import { accountsSchema, profileSchema, selectSchema, resetIntentSchema, resetConfirmSchema, resetStatusSchema, resetIntentStatusSchema } from './schema.js'
import { requireXboardBotEnabled, verifyXboardBotSignature } from './signature.js'
import { handleXboardQuery } from './controller.js'

export const xboardBotRoutes = Router({ caseSensitive: true, strict: true })
xboardBotRoutes.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
xboardBotRoutes.use(requireXboardBotEnabled)
xboardBotRoutes.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } } }))
const parser = raw({ type: () => true, limit: '8kb', inflate: false })
for (const [path, schema, action] of [
  ['/reset-intent-status', resetIntentStatusSchema, 'reset-intent-status'],
  ['/reset-intents', resetIntentSchema, 'reset-intents'], ['/resets', resetConfirmSchema, 'resets'], ['/reset-status', resetStatusSchema, 'reset-status'],
  ['/purchase-reset', profileSchema, 'purchase-reset'],
  ['/accounts', accountsSchema, 'accounts'], ['/profile', profileSchema, 'profile'], ['/select-default', selectSchema, 'select-default'],
] as const) xboardBotRoutes.post(path, parser, verifyXboardBotSignature, validate(schema), handleXboardQuery(action))
const parserError: ErrorRequestHandler = (error, _req, _res, next) => {
  if (error?.type === 'entity.too.large') return next(new HttpError(413, 'BAD_REQUEST', '请求内容过大'))
  if (error?.type === 'encoding.unsupported') return next(new HttpError(415, 'BAD_REQUEST', '不支持的内容编码'))
  next(error)
}
xboardBotRoutes.use(parserError)
