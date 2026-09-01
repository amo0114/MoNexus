import { formatCurrencyAmount } from './money'

export const VMQFOX_CNY_EXAMPLE_CODE = 'rp-cny-vmqfox-v1'
export const VMQFOX_CNY_EXAMPLE_TEN_YUAN_POINTS = '1000'

function parsePositiveDecimal(value: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(value.trim())) return null
  try {
    return BigInt(value.trim())
  } catch {
    return null
  }
}

function halfEvenDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient
  const twice = remainder * 2n
  if (twice < denominator) return quotient
  if (twice > denominator) return quotient + 1n
  return quotient % 2n === 0n ? quotient : quotient + 1n
}

export function formatFenPointRatio(pointsNumerator: string, pointsDenominator: string): string | null {
  if (parsePositiveDecimal(pointsNumerator) == null || parsePositiveDecimal(pointsDenominator) == null) {
    return null
  }
  return `${pointsNumerator.trim()} PTS / ${pointsDenominator.trim()} 分`
}

export function previewTenYuanCredit(input: {
  currency: string
  currencyScale?: number
  pointsNumerator: string
  pointsDenominator: string
}): { ratio: string; preview: string; tenYuanPoints: string } | null {
  const numerator = parsePositiveDecimal(input.pointsNumerator)
  const denominator = parsePositiveDecimal(input.pointsDenominator)
  if (numerator == null || denominator == null) return null
  const scale = input.currencyScale ?? 2
  const tenYuanMinor = 10n * (10n ** BigInt(scale))
  const tenYuanPoints = halfEvenDiv(tenYuanMinor * numerator, denominator).toString(10)
  const ratio = formatFenPointRatio(input.pointsNumerator, input.pointsDenominator)
  if (!ratio) return null
  return {
    ratio,
    tenYuanPoints,
    preview: `${formatCurrencyAmount(tenYuanMinor.toString(10), input.currency)} → ${tenYuanPoints} 积分`,
  }
}

export function vmqfoxCnyExampleRateMismatch(input: {
  code: string
  pointsNumerator: string
  pointsDenominator: string
}): boolean {
  if (input.code.trim() !== VMQFOX_CNY_EXAMPLE_CODE) return false
  const preview = previewTenYuanCredit({
    currency: 'CNY',
    pointsNumerator: input.pointsNumerator,
    pointsDenominator: input.pointsDenominator,
  })
  return preview == null || preview.tenYuanPoints !== VMQFOX_CNY_EXAMPLE_TEN_YUAN_POINTS
}
