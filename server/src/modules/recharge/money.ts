import { convertPointsToReferenceAtomic } from '../valuePolicy/money.js'
import type { MoneyRoundingMode, RechargeCurrency } from './types.js'
import { MONEY_ROUNDING_MODE } from './types.js'

/** PostgreSQL BIGINT upper bound; longer decimal strings cannot be stored. */
export const PG_INT8_MAX = 9223372036854775807n
export const MAX_AMOUNT_MINOR_DIGITS = 19

export type IsoCurrencyMetadata = {
  code: string
  numericCode: number
  scale: number
  name: string
}

export const ISO_CURRENCY_METADATA = {
  CNY: { code: 'CNY', numericCode: 156, scale: 2, name: 'Yuan Renminbi' },
  USD: { code: 'USD', numericCode: 840, scale: 2, name: 'US Dollar' },
  EUR: { code: 'EUR', numericCode: 978, scale: 2, name: 'Euro' },
} as const satisfies Record<string, IsoCurrencyMetadata>

export type SupportedIsoCurrency = keyof typeof ISO_CURRENCY_METADATA

/** V1 platform floors and deploy hard caps (minor units). Policy rows may be lower. */
export const PLATFORM_CURRENCY_LIMITS = {
  CNY: {
    code: 'CNY' as const,
    scale: 2,
    minAmountMinor: 100n,
    maxAmountMinor: 100_000n,
    dailyLimitMinor: 200_000n,
    monthlyLimitMinor: 1_000_000n,
  },
  USD: {
    code: 'USD' as const,
    scale: 2,
    minAmountMinor: 100n,
    maxAmountMinor: 50_000n,
    dailyLimitMinor: 100_000n,
    monthlyLimitMinor: 500_000n,
  },
} as const

export type PlatformCurrency = keyof typeof PLATFORM_CURRENCY_LIMITS

export class AmountParseError extends Error {
  readonly code = 'RECHARGE_AMOUNT_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'AmountParseError'
  }
}

export function isPlatformCurrency(code: string): code is PlatformCurrency {
  return Object.hasOwn(PLATFORM_CURRENCY_LIMITS, code)
}

export function getIsoCurrencyMetadata(code: string): IsoCurrencyMetadata {
  if (!Object.hasOwn(ISO_CURRENCY_METADATA, code)) {
    throw new AmountParseError(`unsupported currency ${code}`)
  }
  return ISO_CURRENCY_METADATA[code as SupportedIsoCurrency]
}

export function getPlatformCurrencyLimits(currency: RechargeCurrency | string) {
  if (!isPlatformCurrency(currency)) {
    throw new AmountParseError(`unsupported recharge currency ${currency}`)
  }
  return PLATFORM_CURRENCY_LIMITS[currency]
}

/**
 * API-boundary parser. Rejects JSON numbers so clients cannot send IEEE-754
 * amounts; only a canonical non-negative decimal integer string is accepted.
 */
export function parseAmountMinorString(value: unknown): bigint {
  if (typeof value === 'number') {
    throw new AmountParseError('JSON number is not allowed for money fields')
  }
  if (typeof value === 'bigint') {
    throw new AmountParseError('money must be a decimal string')
  }
  if (typeof value !== 'string') {
    throw new AmountParseError('money must be a decimal string')
  }
  if (value.length === 0) {
    throw new AmountParseError('money string must not be empty')
  }
  if (value.length > MAX_AMOUNT_MINOR_DIGITS) {
    throw new AmountParseError('money string is overlong')
  }
  if (/\s/.test(value) || value !== value.trim()) {
    throw new AmountParseError('whitespace is not allowed in money strings')
  }
  if (/[eE]/.test(value)) {
    throw new AmountParseError('exponent notation is not allowed in money strings')
  }
  if (value.startsWith('-') || value.startsWith('+')) {
    throw new AmountParseError('signed money strings are not allowed')
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AmountParseError('money must be a canonical decimal integer string')
  }
  const amount = BigInt(value)
  if (amount < 0n) {
    throw new AmountParseError('money must be non-negative')
  }
  if (amount > PG_INT8_MAX) {
    throw new AmountParseError('money exceeds int64 storage')
  }
  return amount
}

export function serializeAmountMinor(amount: bigint): string {
  if (typeof amount !== 'bigint') {
    throw new AmountParseError('amount must be a bigint')
  }
  if (amount < 0n) {
    throw new AmountParseError('amount must be non-negative')
  }
  return amount.toString(10)
}

export type FloorComparison = 'below' | 'floor' | 'above'

/** CNY/USD 1.00 floor: 99 below, 100 on floor, 101 above. */
export function compareToPlatformFloor(
  currency: RechargeCurrency | string,
  amountMinor: bigint,
): FloorComparison {
  if (typeof amountMinor !== 'bigint') {
    throw new AmountParseError('amountMinor must be a bigint')
  }
  const floor = getPlatformCurrencyLimits(currency).minAmountMinor
  if (amountMinor < floor) return 'below'
  if (amountMinor === floor) return 'floor'
  return 'above'
}

export function meetsPlatformMinimum(
  currency: RechargeCurrency | string,
  amountMinor: bigint,
): boolean {
  return compareToPlatformFloor(currency, amountMinor) !== 'below'
}

export type ConvertRechargePointsInput = {
  amountMinor: bigint
  pointsNumerator: bigint
  pointsDenominator: bigint
  roundingMode: MoneyRoundingMode
}

/**
 * points = HALF_EVEN(amountMinor * pointsNumerator / pointsDenominator)
 * Delegates to valuePolicy BigInt HALF_EVEN; no float amount math.
 */
export function convertAmountMinorToPoints(input: ConvertRechargePointsInput): bigint {
  if (input.roundingMode !== MONEY_ROUNDING_MODE) {
    throw new Error('roundingMode must be HALF_EVEN')
  }
  return convertPointsToReferenceAtomic({
    pointsAtomic: input.amountMinor,
    referenceAtomicPerPointNumerator: input.pointsNumerator,
    referenceAtomicPerPointDenominator: input.pointsDenominator,
    roundingMode: input.roundingMode,
  })
}
