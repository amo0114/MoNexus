import { Router, type Request, type Response, type NextFunction } from 'express'
import { config } from '../../../config/index.js'
import { prisma } from '../../../lib/prisma.js'
import { forbidden, HttpError, notFound } from '../../../lib/httpError.js'
import { validate } from '../../../middlewares/validate.js'
import { draftQuery, emptyQuery, itemParams, type WorkbenchRule } from './schema.js'
import * as service from './service.js'

export const workbenchRoutes = Router()
// Mounted AFTER authenticate/requireActiveUser/requireMerchant. No credential or scope from query strings.
workbenchRoutes.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  if (!config.merchantWorkbenchEnabled) return next(notFound())
  next()
})

function read(handler: (merchantId: number, req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const merchant = await prisma.merchant.findUnique({ where: { userId: req.user!.userId }, select: { id: true, status: true } })
      if (!merchant || merchant.status !== 'active') throw forbidden('需要已激活商家权限')
      res.json(await handler(merchant.id, req))
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(503, 'INTERNAL_SERVER_ERROR', '事项暂未检查，请稍后重试'))
    }
  }
}
workbenchRoutes.get('/urgent', validate({ query: emptyQuery }), read(id => service.getUrgent(id)))
workbenchRoutes.get('/availability', validate({ query: emptyQuery }), read(id => service.getAvailability(id)))
workbenchRoutes.get('/drafts', validate({ query: draftQuery }), read((id, req) => service.getDrafts(id, req.query.beforeProductId as unknown as number | undefined)))
workbenchRoutes.get('/items/:rule/:targetId', validate({ query: emptyQuery, params: itemParams }),
  read((id, req) => service.getItem(id, req.params.rule as WorkbenchRule, Number(req.params.targetId))))
