import { z } from 'zod'
import { AmountParseError, parseAmountMinorString } from './money.js'
import { AMOUNT_SOURCES, PAYMENT_PROVIDER_NAMES, RECHARGE_CURRENCIES, RECHARGE_ORDER_STATUSES } from './types.js'

export const rechargeIdempotencyKeySchema = z.string().uuid()

export const uuidParamSchema = z.object({
  id: z.string().uuid('必须是 UUID'),
})

const amountMinorSchema = z.string().superRefine((value, ctx) => {
  try {
    parseAmountMinorString(value)
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof AmountParseError ? err.message : '金额必须是十进制字符串',
    })
  }
})

export const rechargeConfigQuerySchema = z.object({
  currency: z.enum(RECHARGE_CURRENCIES),
})

export const createQuoteSchema = z.object({
  currency: z.enum(RECHARGE_CURRENCIES),
  amountMinor: amountMinorSchema,
  amountSource: z.enum(AMOUNT_SOURCES),
  provider: z.enum(PAYMENT_PROVIDER_NAMES),
  paymentMethod: z.string().trim().min(1).max(64),
})

export const createOrderSchema = z.object({
  quoteId: z.string().uuid(),
})

export const listOrdersQuerySchema = z.object({
  status: z.enum(RECHARGE_ORDER_STATUSES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
