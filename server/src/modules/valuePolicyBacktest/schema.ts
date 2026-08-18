import { z } from 'zod'
import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'
import { INPUT_LIMITS, INPUT_SCHEMA_VERSION } from './thresholds.js'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/
const DECIMAL_AMOUNT = /^(0|[1-9][0-9]*)$/
const PSEUDONYMOUS_REF = /^[A-Za-z0-9_-]{16,128}$/
const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function amountField(field: string) {
  return z.preprocess((value, ctx) => {
    if (typeof value === 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: BACKTEST_ERROR_CODES.JSON_NUMBER_AMOUNT,
        path: [field],
      })
      return z.NEVER
    }
    return value
  }, z.string({
    required_error: `${field} is required`,
    invalid_type_error: `${field} must be a decimal string`,
  }).superRefine((value, ctx) => {
    if (value.startsWith('-')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: BACKTEST_ERROR_CODES.NEGATIVE_AMOUNT })
      return
    }
    if (!DECIMAL_AMOUNT.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: BACKTEST_ERROR_CODES.NON_DECIMAL_AMOUNT })
    }
  }))
}

function optionalAmountField(field: string) {
  return z.preprocess((value, ctx) => {
    if (value === undefined || value === null) {
      return undefined
    }
    if (typeof value === 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: BACKTEST_ERROR_CODES.JSON_NUMBER_AMOUNT,
        path: [field],
      })
      return z.NEVER
    }
    return value
  }, amountField(field).optional())
}

function refField(field: string) {
  return z.string().superRefine((value, ctx) => {
    if (/^\d+$/.test(value) || !PSEUDONYMOUS_REF.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: BACKTEST_ERROR_CODES.IDENTIFIER_NOT_PSEUDONYMOUS,
        path: [field],
      })
    }
  })
}

export const offerInputSchema = z.object({
  offerRef: refField('offerRef'),
  category: z.string().regex(CATEGORY, 'category must be a short token without PII'),
  pricePoints: amountField('pricePoints'),
  merchantCostCnyAtomic: optionalAmountField('merchantCostCnyAtomic'),
}).strict()

export const accountInputSchema = z.object({
  accountRef: refField('accountRef'),
  balancePoints: amountField('balancePoints'),
  frozenPoints: amountField('frozenPoints'),
}).strict()

export const monthlyActivityInputSchema = z.object({
  month: z.string().regex(YEAR_MONTH, BACKTEST_ERROR_CODES.INVALID_MONTH),
  accountRef: refField('accountRef'),
  earnedPoints: amountField('earnedPoints'),
  spentPoints: amountField('spentPoints'),
  expiredPoints: amountField('expiredPoints'),
  refundedPoints: amountField('refundedPoints'),
}).strict()

export const orderInputSchema = z.object({
  orderRef: refField('orderRef'),
  offerRef: refField('offerRef'),
  accountRef: refField('accountRef').optional(),
  points: amountField('points'),
  status: z.enum(['completed', 'refunded', 'cancelled', 'pending']),
}).strict()

export const backtestInputSchema = z.object({
  schemaVersion: z.number().int(),
  period: z.object({
    from: z.string().regex(ISO_INSTANT, BACKTEST_ERROR_CODES.INVALID_PERIOD),
    to: z.string().regex(ISO_INSTANT, BACKTEST_ERROR_CODES.INVALID_PERIOD),
  }).strict(),
  offers: z.array(offerInputSchema).max(INPUT_LIMITS.maxOffers),
  accounts: z.array(accountInputSchema).max(INPUT_LIMITS.maxAccounts),
  monthlyActivity: z.array(monthlyActivityInputSchema).max(INPUT_LIMITS.maxMonthlyActivity),
  orders: z.array(orderInputSchema).max(INPUT_LIMITS.maxOrders),
}).strict()

export type RawBacktestInput = z.infer<typeof backtestInputSchema>

export function assertKnownSchemaVersion(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_JSON, 'input root must be an object')
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion
  if (version !== INPUT_SCHEMA_VERSION) {
    throw new BacktestError(
      BACKTEST_ERROR_CODES.UNKNOWN_SCHEMA_VERSION,
      'unsupported input schemaVersion',
      { expected: INPUT_SCHEMA_VERSION },
    )
  }
}

export function firstZodBacktestCode(issues: z.ZodIssue[]): { code: string; path: string } | null {
  for (const issue of issues) {
    if (issue.message === BACKTEST_ERROR_CODES.JSON_NUMBER_AMOUNT
      || issue.message === BACKTEST_ERROR_CODES.NEGATIVE_AMOUNT
      || issue.message === BACKTEST_ERROR_CODES.NON_DECIMAL_AMOUNT
      || issue.message === BACKTEST_ERROR_CODES.IDENTIFIER_NOT_PSEUDONYMOUS
      || issue.message === BACKTEST_ERROR_CODES.INVALID_MONTH
      || issue.message === BACKTEST_ERROR_CODES.INVALID_PERIOD) {
      return { code: issue.message, path: issue.path.join('.') }
    }
    if (issue.code === z.ZodIssueCode.too_big) {
      return { code: BACKTEST_ERROR_CODES.TOO_MANY_ROWS, path: issue.path.join('.') }
    }
  }
  return null
}

export { ISO_INSTANT, YEAR_MONTH, DECIMAL_AMOUNT }
