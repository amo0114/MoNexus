import { Request, Response, NextFunction } from 'express'
import * as orderService from './service.js'
import { issueOrderFileDownloadUrl } from './fileAccess.js'
import { idempotencyKeySchema } from './schema.js'
import { badRequest } from '../../lib/httpError.js'

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    let idempotencyKey: string | undefined
    const rawKey = req.header('Idempotency-Key')
    if (rawKey != null) {
      const parsed = idempotencyKeySchema.safeParse(rawKey)
      if (!parsed.success) throw badRequest('Idempotency-Key 必须是 UUID')
      idempotencyKey = parsed.data
    }

    const result = await orderService.createOrder(req.user!.userId, req.body.productId, {
      offerId: req.body.offerId,
      expectedPrice: req.body.expectedPrice,
      expectedCheckoutVersion: req.body.expectedCheckoutVersion,
      formAnswers: req.body.formAnswers,
      expectedPurchaseFormVersion: req.body.expectedPurchaseFormVersion,
      verificationPassword: req.body.verificationPassword,
      renewalOfOrderId: req.body.renewalOfOrderId,
      agreementVersions: req.body.agreementVersions,
      expectedValuePolicyId: req.body.expectedValuePolicyId,
      idempotencyKey,
      // SPEC-LEGAL-001：订单确认证据的网络标识（同 fileAccess 的采集先例）。
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, pageSize, status } = req.query as { page?: number; pageSize?: number; status?: string }
    const orders = await orderService.getUserOrders(
      req.user!.userId,
      Number(page) || 1,
      Number(pageSize) || 20,
      status
    )
    res.json(orders)
  } catch (err) {
    next(err)
  }
}

// PR-3：买家「进行中」订单权威计数（红点角标）。只按当前用户统计，
// 响应 { count }，与列表分页完全解耦。
export async function attentionCount(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await orderService.getAttentionOrderCount(req.user!.userId)
    res.json({ count })
  } catch (err) {
    next(err)
  }
}

export async function dispute(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.disputeOrder(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(order)
  } catch (err) {
    next(err)
  }
}

export async function close(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.closeOrder(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(order)
  } catch (err) {
    next(err)
  }
}

// P6a：手动续费预检——只读无副作用；实际续费走标准下单携带 renewalOfOrderId。
export async function renewPrecheck(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await orderService.renewOrderPrecheck(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.getOrderDetail(
      req.params.id as unknown as number,
      req.user!.userId,
    )
    res.json(order)
  } catch (err) {
    next(err)
  }
}

// P5：受控文件下载发放。响应 no-store——签名 URL 不允许进任何缓存层。
export async function issueFileDownloadUrl(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await issueOrderFileDownloadUrl(req.params.id as unknown as number, {
      userId: req.user!.userId,
      userRole: req.user!.role,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json(result)
  } catch (err) {
    next(err)
  }
}
