import { z } from 'zod'
import { markNotWritableFields } from '../../middlewares/validate.js'
import {
  MONEY_ROUNDING_MODE,
  PAYMENT_DISPUTE_STATUSES,
  PAYMENT_EVENT_STATUSES,
  PAYMENT_PROVIDER_NAMES,
  RECHARGE_CURRENCIES,
  RECHARGE_ORDER_STATUSES,
  RECHARGE_PRICE_POLICY_STATUSES,
  RECHARGE_REFUND_STATUSES,
  RECONCILIATION_SCOPE_TYPES,
} from './types.js'
import { parseAmountMinorString, AmountParseError } from './money.js'
import { isValidCalendarDate } from '../admin/schema.js'

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

export function parseAndValidateStrictRefundDate(val: string): {
  valid: boolean
  error?: string
  date?: Date
  isDateOnly?: boolean
} {
  // Pattern 1: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    if (!isValidCalendarDate(val)) {
      return { valid: false, error: '无效公历日期' }
    }
    return { valid: true, isDateOnly: true, date: new Date(`${val}T00:00:00.000Z`) }
  }

  // Pattern 2: Strict RFC 3339 / ISO 8601 with timezone (Z or [+-]HH:mm)
  const rfc3339Regex = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
  const match = rfc3339Regex.exec(val)
  if (!match) {
    return {
      valid: false,
      error: '无效日期格式，必须是 YYYY-MM-DD 或带明确时区的 RFC 3339 时间戳 (例如 2026-09-04T00:00:00Z)',
    }
  }

  const [, datePart, hourStr, minStr, secStr] = match
  if (!isValidCalendarDate(datePart)) {
    return { valid: false, error: '无效公历日期' }
  }

  const hour = Number(hourStr)
  const minute = Number(minStr)
  const second = Number(secStr)
  if (hour > 23 || minute > 59 || second > 59) {
    return { valid: false, error: '无效时间数值' }
  }

  const parsed = new Date(val)
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: '无法解析的时间戳' }
  }

  return { valid: true, isDateOnly: false, date: parsed }
}

const refundDateSchema = z.string().trim().superRefine((val, ctx) => {
  const result = parseAndValidateStrictRefundDate(val)
  if (!result.valid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error || '无效日期格式' })
  }
})

const refundOrderIdSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    '充值订单号必须是 36 位规范完整 UUID (例如 c0a80101-0000-4000-8000-000000000001)',
  )

export const adminListRefundsQuerySchema = z
  .object({
    status: z.enum(RECHARGE_REFUND_STATUSES).optional(),
    userId: z.coerce.number().int().positive().optional(),
    orderId: refundOrderIdSchema.optional(),
    provider: z.enum(PAYMENT_PROVIDER_NAMES).optional(),
    from: refundDateSchema.optional(),
    to: refundDateSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        const fromResult = parseAndValidateStrictRefundDate(data.from)
        const toResult = parseAndValidateStrictRefundDate(data.to)
        if (fromResult.valid && toResult.valid && fromResult.date && toResult.date) {
          return fromResult.date.getTime() <= toResult.date.getTime()
        }
      }
      return true
    },
    { message: 'from 不能晚于 to', path: ['to'] },
  )

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

export const adminListPricePoliciesQuerySchema = z.object({
  currency: z.enum(RECHARGE_CURRENCIES).optional(),
  status: z.enum(RECHARGE_PRICE_POLICY_STATUSES).optional(),
  adminSandbox: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

const positiveMinorSchema = z.string().superRefine((value, ctx) => {
  try {
    const amount = parseAmountMinorString(value)
    if (amount <= 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '必须是正十进制整数字符串' })
    }
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof AmountParseError ? err.message : '必须是正十进制整数字符串',
    })
  }
})

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

const suggestedAmountSchema = z.object({
  amountMinor: amountMinorSchema,
  sortOrder: z.number().int().min(0).max(999),
})

export const adminCreatePricePolicySchema = markNotWritableFields(
  z.object({
    code: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, '代码格式无效'),
    currency: z.enum(RECHARGE_CURRENCIES),
    currencyScale: z.number().int().positive(),
    pointsNumerator: positiveMinorSchema,
    pointsDenominator: positiveMinorSchema,
    roundingMode: z.literal(MONEY_ROUNDING_MODE),
    minAmountMinor: amountMinorSchema,
    maxAmountMinor: amountMinorSchema,
    amountStepMinor: positiveMinorSchema,
    dailyLimitMinor: amountMinorSchema,
    monthlyLimitMinor: amountMinorSchema,
    limitTimeZone: z.string().trim().min(1).max(64).refine(isIanaTimeZone, '必须是 IANA 时区'),
    adminSandbox: z.boolean().optional().default(false),
    bonusRuleVersion: z.string().trim().min(1).max(64).nullable().optional(),
    suggestedAmounts: z.array(suggestedAmountSchema).max(20).default([]),
  }).strict(),
  ['id', 'status', 'version', 'effectiveAt'],
)

export type AdminCreatePricePolicyBody = z.infer<typeof adminCreatePricePolicySchema>
export type AdminListPricePoliciesQuery = z.infer<typeof adminListPricePoliciesQuerySchema>

/**
 * Admin-only create payload example for the VMQFox CNY production lane.
 * pointsNumerator/Denominator mean 1 PTS per 1 CNY minor unit (fen).
 * Create stays draft; never auto-activate this policy in a migration.
 */
export const RP_CNY_VMQFOX_V1_CREATE_EXAMPLE = {
  code: 'rp-cny-vmqfox-v1',
  currency: 'CNY',
  currencyScale: 2,
  pointsNumerator: '1',
  pointsDenominator: '1',
  roundingMode: MONEY_ROUNDING_MODE,
  minAmountMinor: '100',
  maxAmountMinor: '100000',
  amountStepMinor: '100',
  dailyLimitMinor: '200000',
  monthlyLimitMinor: '1000000',
  limitTimeZone: 'Asia/Shanghai',
  suggestedAmounts: [
    { amountMinor: '1000', sortOrder: 1 },
    { amountMinor: '3000', sortOrder: 2 },
    { amountMinor: '5000', sortOrder: 3 },
    { amountMinor: '10000', sortOrder: 4 },
  ],
} satisfies Omit<AdminCreatePricePolicyBody, 'adminSandbox' | 'bonusRuleVersion'>

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
