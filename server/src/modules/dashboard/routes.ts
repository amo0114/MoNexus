import type { Request, Response, NextFunction } from 'express'
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { authenticate, requireActiveUser, requireMerchant } from '../../middlewares/auth.js'
import * as controller from './controller.js'

declare module '../../middlewares/auth.js' {
  interface AuthPayload {
    merchantId?: number
  }
}

const router = Router()

async function attachMerchantId(req: Request, _res: Response, next: NextFunction) {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { userId: req.user!.userId },
      select: { id: true },
    })

    if (!merchant) {
      next(notFound('商家账户不存在'))
      return
    }

    req.user!.merchantId = merchant.id
    next()
  } catch (err) {
    next(err)
  }
}

router.use(authenticate, requireActiveUser, requireMerchant, attachMerchantId)

router.get('/summary', controller.summary)
router.get('/timeseries', controller.timeseries)

export { router as dashboardRoutes }
