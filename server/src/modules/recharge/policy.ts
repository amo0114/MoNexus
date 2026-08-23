import { prisma } from '../../lib/prisma.js'
import {
  rechargeAmountAboveMaximum,
  rechargeAmountBelowMinimum,
  rechargeAmountStepInvalid,
  rechargeCurrencyDisabled,
} from '../../lib/httpError.js'
import { convertAmountMinorToPoints, getPlatformCurrencyLimits } from './money.js'
import { MONEY_ROUNDING_MODE, type AmountSource, type RechargeCurrency } from './types.js'

export type ActivePricePolicy = {
  id: string
  code: string
  version: number
  currency: RechargeCurrency
  currencyScale: number
  pointsNumerator: bigint
  pointsDenominator: bigint
  roundingMode: typeof MONEY_ROUNDING_MODE
  minAmountMinor: bigint
  maxAmountMinor: bigint
  amountStepMinor: bigint
  dailyLimitMinor: bigint
  monthlyLimitMinor: bigint
  limitTimeZone: string
  bonusRuleVersion: string | null
  suggestedAmounts: Array<{ amountMinor: bigint; sortOrder: number }>
}

export type EffectiveBounds = {
  minAmountMinor: bigint
  maxAmountMinor: bigint
}

export async function getActivePricePolicy(
  currency: RechargeCurrency,
  adminSandbox = false,
): Promise<ActivePricePolicy> {
  const row = await prisma.rechargePricePolicy.findFirst({
    where: { currency, adminSandbox, status: 'active' },
    include: { suggestedAmounts: { orderBy: { sortOrder: 'asc' } } },
  })
  if (!row) throw rechargeCurrencyDisabled('当前币种没有生效的充值价格政策')
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    currency: row.currency as RechargeCurrency,
    currencyScale: row.currencyScale,
    pointsNumerator: row.pointsNumerator,
    pointsDenominator: row.pointsDenominator,
    roundingMode: MONEY_ROUNDING_MODE,
    minAmountMinor: row.minAmountMinor,
    maxAmountMinor: row.maxAmountMinor,
    amountStepMinor: row.amountStepMinor,
    dailyLimitMinor: row.dailyLimitMinor,
    monthlyLimitMinor: row.monthlyLimitMinor,
    limitTimeZone: row.limitTimeZone,
    bonusRuleVersion: row.bonusRuleVersion,
    suggestedAmounts: row.suggestedAmounts.map(item => ({
      amountMinor: item.amountMinor,
      sortOrder: item.sortOrder,
    })),
  }
}

export function effectiveAmountBounds(
  currency: RechargeCurrency,
  policy: Pick<ActivePricePolicy, 'minAmountMinor' | 'maxAmountMinor'>,
  providerMin: bigint,
  providerMax: bigint | null,
): EffectiveBounds {
  const platform = getPlatformCurrencyLimits(currency)
  const minAmountMinor = [platform.minAmountMinor, policy.minAmountMinor, providerMin]
    .reduce((left, right) => (left > right ? left : right))
  const candidates = [platform.maxAmountMinor, policy.maxAmountMinor]
  if (providerMax != null) candidates.push(providerMax)
  const maxAmountMinor = candidates.reduce((left, right) => (left < right ? left : right))
  return { minAmountMinor, maxAmountMinor }
}

export function assertAmountAllowed(input: {
  amountMinor: bigint
  amountSource: AmountSource
  bounds: EffectiveBounds
  stepMinor: bigint
  suggestedAmounts: readonly bigint[]
}) {
  if (input.amountMinor < input.bounds.minAmountMinor) {
    throw rechargeAmountBelowMinimum()
  }
  if (input.amountMinor > input.bounds.maxAmountMinor) {
    throw rechargeAmountAboveMaximum()
  }
  if (input.stepMinor > 0n && input.amountMinor % input.stepMinor !== 0n) {
    throw rechargeAmountStepInvalid()
  }
  if (input.amountSource === 'suggested' && !input.suggestedAmounts.includes(input.amountMinor)) {
    throw rechargeAmountStepInvalid('推荐金额不在当前政策列表中')
  }
}

export function priceAmount(policy: ActivePricePolicy, amountMinor: bigint) {
  const basePoints = convertAmountMinorToPoints({
    amountMinor,
    pointsNumerator: policy.pointsNumerator,
    pointsDenominator: policy.pointsDenominator,
    roundingMode: MONEY_ROUNDING_MODE,
  })
  const bonusPoints = 0n
  return { basePoints, bonusPoints, totalPoints: basePoints + bonusPoints }
}
