import { convertPointsToReferenceAtomic } from '../valuePolicy/money.js'
import type { MoneyRoundingMode, RechargeCurrency } from './types.js'
import { MONEY_ROUNDING_MODE } from './types.js'

import { AmountParseError, getPlatformCurrencyLimits } from '../../lib/minorAmounts.js'

export * from '../../lib/minorAmounts.js'

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
