import { formatRate } from './format.js'

export const QUANTILE_PERCENTS = [10, 25, 50, 75, 90] as const
export type QuantilePercent = (typeof QUANTILE_PERCENTS)[number]

export type QuantileMap = {
  p10: string | null
  p25: string | null
  p50: string | null
  p75: string | null
  p90: string | null
}

export type NullReason = {
  value: null
  reason: string
}

/**
 * Nearest-rank quantile. Rank = ceil(p/100 * n). No interpolation, so the
 * result is always an observed sample and stays on the integer lattice.
 */
export function quantileNearestRank(sortedAscending: readonly bigint[], percent: number): bigint | null {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error('percent must be an integer between 0 and 100')
  }
  const n = sortedAscending.length
  if (n === 0) {
    return null
  }
  if (percent === 0) {
    return sortedAscending[0]
  }
  const rank = (BigInt(n) * BigInt(percent) + 99n) / 100n
  const index = Number(rank < 1n ? 1n : rank) - 1
  return sortedAscending[Math.min(Math.max(index, 0), n - 1)]
}

export function quantileMap(values: readonly bigint[]): QuantileMap {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    p10: optionalDecimal(quantileNearestRank(sorted, 10)),
    p25: optionalDecimal(quantileNearestRank(sorted, 25)),
    p50: optionalDecimal(quantileNearestRank(sorted, 50)),
    p75: optionalDecimal(quantileNearestRank(sorted, 75)),
    p90: optionalDecimal(quantileNearestRank(sorted, 90)),
  }
}

export function optionalDecimal(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString(10)
}

export function sumBigint(values: readonly bigint[]): bigint {
  let total = 0n
  for (const value of values) {
    total += value
  }
  return total
}

export function averageFloor(total: bigint, count: bigint): bigint | null {
  if (count === 0n) {
    return null
  }
  return total / count
}

export type ConcentrationResult = {
  sampleSize: number
  selectedCount: number
  selectedSum: string | null
  totalSum: string | null
  share: string | null
  suppressed: boolean
  reason: string | null
}

export function concentrationTopShare(
  values: readonly bigint[],
  percent: number,
  minSample: number,
): ConcentrationResult {
  if (!Number.isInteger(percent) || percent <= 0 || percent > 100) {
    throw new Error('percent must be an integer between 1 and 100')
  }
  const sampleSize = values.length
  if (sampleSize === 0 || sampleSize < minSample) {
    return {
      sampleSize,
      selectedCount: 0,
      selectedSum: null,
      totalSum: null,
      share: null,
      suppressed: true,
      reason: sampleSize === 0 ? 'empty_sample' : 'sample_below_threshold',
    }
  }
  const sortedDesc = [...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
  const selectedCount = Number((BigInt(sampleSize) * BigInt(percent) + 99n) / 100n)
  const selected = sortedDesc.slice(0, Math.max(selectedCount, 1))
  const selectedSum = sumBigint(selected)
  const totalSum = sumBigint(sortedDesc)
  return {
    sampleSize,
    selectedCount: selected.length,
    selectedSum: selectedSum.toString(10),
    totalSum: totalSum.toString(10),
    share: formatRate(selectedSum, totalSum),
    suppressed: false,
    reason: totalSum === 0n ? 'zero_total' : null,
  }
}

export function ratioOrNull(numerator: bigint, denominator: bigint, reason: string): {
  rate: string | null
  reason: string | null
} {
  if (denominator === 0n) {
    return { rate: null, reason }
  }
  return { rate: formatRate(numerator, denominator), reason: null }
}

export function monthsToAfford(costPoints: bigint, monthlyEarnedPoints: bigint): {
  months: string | null
  reason: string | null
} {
  if (monthlyEarnedPoints === 0n) {
    return { months: null, reason: costPoints === 0n ? 'zero_earned_and_zero_price' : 'zero_median_earned' }
  }
  if (costPoints === 0n) {
    return { months: '0.00', reason: null }
  }
  const exact = (costPoints * 100n + monthlyEarnedPoints - 1n) / monthlyEarnedPoints
  const whole = exact / 100n
  const fraction = exact % 100n
  return { months: `${whole.toString(10)}.${fraction.toString(10).padStart(2, '0')}`, reason: null }
}

export function unitsAffordable(budgetPoints: bigint, unitCostPoints: bigint): {
  units: string | null
  reason: string | null
} {
  if (unitCostPoints === 0n) {
    return { units: null, reason: 'zero_offer_price' }
  }
  if (budgetPoints === 0n) {
    return { units: '0.00', reason: null }
  }
  const scaled = (budgetPoints * 100n) / unitCostPoints
  const whole = scaled / 100n
  const fraction = scaled % 100n
  return { units: `${whole.toString(10)}.${fraction.toString(10).padStart(2, '0')}`, reason: null }
}
