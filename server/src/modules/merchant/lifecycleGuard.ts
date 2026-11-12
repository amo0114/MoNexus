import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../../lib/prisma.js'
import { forbidden } from '../../lib/httpError.js'
import { requireMerchant } from '../../middlewares/auth.js'
/** Ownership allows historical access; individual write capabilities stay explicit. */
export async function requireMerchantRoute(req: Request, res: Response, next: NextFunction) {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { userId: req.user!.userId },
      select: { status: true },
    })
    if (merchant?.status === 'active') return requireMerchant(req, res, next)
    const read =
      req.method === 'GET' &&
      /^\/(me|orders(?:\/\d+)?|settlements|stats|finance\/(summary|entries)|products\/\d+\/(?:inventory\/batches(?:\/[^/]+)?|offers\/\d+\/revisions))$/.test(
        req.path,
      )
    const existing =
      merchant?.status === 'suspended' &&
      req.method === 'POST' &&
      /^\/orders\/\d+\/(?:progress|fulfillment\/(?:deliver|respond-dispute|reject|unfulfillable))$/.test(
        req.path,
      )
    if (merchant && (read || existing)) return next()
    throw forbidden('当前商家能力不允许此操作')
  } catch (e) {
    next(e)
  }
}
