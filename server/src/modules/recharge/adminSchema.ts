import { z } from 'zod'
import {
  PAYMENT_DISPUTE_STATUSES,
  PAYMENT_EVENT_STATUSES,
  PAYMENT_PROVIDER_NAMES,
  RECHARGE_ORDER_STATUSES,
  RECHARGE_PRICE_POLICY_STATUSES,
  RECONCILIATION_SCOPE_TYPES,
} from './types.js'
import { parseAmountMinorString, AmountParseError } from './money.js'

export const adminUuidParamSchema = z.object({
  id: z.string().uuid('必须是 UUID'),
})

export const adminListOrdersQuerySchema = z.object({
  status: z.enum(RECHARGE_ORDER_STATUSES).optional(),
  userId: z.coerce.number().int().positive().optional(),
  provider: z.enum(PAYMENT_PROVIDER_NAMES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const adminListEventsQuerySchema = z.object({
  status: z.enum(PAYMENT_EVENT_STATUSES).optional(),
  provider: z.enum(PAYMENT_PROVIDER_NAMES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export const adminListDisputesQuerySchema = z.object({
  status: z.enum(PAYMENT_DISPUTE_STATUSES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const adminCreateReconSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_NAMES),
  providerAccountKey: z.string().min(1).max(128).optional(),
  scopeType: z.enum(RECONCILIATION_SCOPE_TYPES).default('provider_query'),
  scopeKey: z.string().min(1).max(128).optional(),
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

export const adminPatchPricePolicySchema = z.object({
  minAmountMinor: amountMinorSchema.optional(),
  maxAmountMinor: amountMinorSchema.optional(),
  amountStepMinor: amountMinorSchema.optional(),
  dailyLimitMinor: amountMinorSchema.optional(),
  monthlyLimitMinor: amountMinorSchema.optional(),
  status: z.enum(RECHARGE_PRICE_POLICY_STATUSES).optional(),
}).refine(value => Object.keys(value).length > 0, { message: '至少提供一个字段' })

export const adminRefundSchema = z.object({
  reasonCode: z.string().min(1).max(64).optional(),
})

export const adminResolveDisputeSchema = z.object({
  outcome: z.enum(['won', 'lost']),
})

export const adminCloseRecoveryCaseSchema = z.object({
  status: z.enum(['recovered', 'written_off', 'restored']),
  resolutionReason: z.string().min(1).max(160).optional(),
})
