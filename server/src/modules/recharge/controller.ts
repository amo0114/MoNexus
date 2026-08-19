import type { NextFunction, Request, Response } from 'express'
import { badRequest } from '../../lib/httpError.js'
import { parseAmountMinorString } from './money.js'
import { rechargeIdempotencyKeySchema } from './schema.js'
import * as rechargeService from './service.js'
import type { AmountSource, PaymentProviderName, RechargeCurrency, RechargeOrderStatus } from './types.js'

function requireIdempotencyKey(req: Request): string {
  const raw = req.header('Idempotency-Key')
  if (raw == null || raw.trim() === '') {
    throw badRequest('缺少 Idempotency-Key 请求头')
  }
  const parsed = rechargeIdempotencyKeySchema.safeParse(raw)
  if (!parsed.success) throw badRequest('Idempotency-Key 必须是 UUID')
  return parsed.data
}

export async function config(req: Request, res: Response, next: NextFunction) {
  try {
    const { currency } = req.query as { currency: RechargeCurrency }
    res.json(await rechargeService.getRechargeConfig(req.user!.userId, currency))
  } catch (err) {
    next(err)
  }
}

export async function createQuote(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as {
      currency: RechargeCurrency
      amountMinor: string
      amountSource: AmountSource
      provider: PaymentProviderName
      paymentMethod: string
    }
    const quote = await rechargeService.createQuote(req.user!.userId, {
      currency: body.currency,
      amountMinor: parseAmountMinorString(body.amountMinor),
      amountSource: body.amountSource,
      provider: body.provider,
      paymentMethod: body.paymentMethod,
    })
    res.status(201).json(quote)
  } catch (err) {
    next(err)
  }
}

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const key = requireIdempotencyKey(req)
    const order = await rechargeService.createOrder(req.user!.userId, req.body.quoteId as string, key)
    res.status(201).json(order)
  } catch (err) {
    next(err)
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as { page: number; pageSize: number; status?: RechargeOrderStatus }
    res.json(await rechargeService.listOrders(req.user!.userId, query))
  } catch (err) {
    next(err)
  }
}

export async function getOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await rechargeService.getOrder(req.user!.userId, String(req.params.id)))
  } catch (err) {
    next(err)
  }
}

export async function completeOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const key = requireIdempotencyKey(req)
    res.json(await rechargeService.completeOrder(req.user!.userId, String(req.params.id), key))
  } catch (err) {
    next(err)
  }
}

export async function cancelOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const key = requireIdempotencyKey(req)
    res.json(await rechargeService.cancelOrder(req.user!.userId, String(req.params.id), key))
  } catch (err) {
    next(err)
  }
}

export async function requestRefund(_req: Request, res: Response, next: NextFunction) {
  try {
    await rechargeService.requestRefund()
    res.status(409).end()
  } catch (err) {
    next(err)
  }
}
