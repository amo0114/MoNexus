import { convertPointsToReferenceAtomic } from '../valuePolicy/money.js'
import { CNY_ATOMIC_PER_MAJOR, CNY_SCALE, RATE_DECIMAL_SCALE } from './thresholds.js'

export function formatDecimalInteger(value: bigint): string {
  if (typeof value !== 'bigint') {
    throw new Error('value must be a bigint')
  }
  return value.toString(10)
}

export function formatCnyFromAtomic(atomic: bigint): string {
  if (typeof atomic !== 'bigint') {
    throw new Error('atomic must be a bigint')
  }
  if (atomic < 0n) {
    throw new Error('atomic must be non-negative')
  }
  const whole = atomic / CNY_ATOMIC_PER_MAJOR
  const fraction = atomic % CNY_ATOMIC_PER_MAJOR
  return `${whole.toString(10)}.${fraction.toString(10).padStart(CNY_SCALE, '0')}`
}

export function formatFixedDecimal(numerator: bigint, denominator: bigint, scale: number): string | null {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    throw new Error('numerator and denominator must be bigint')
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error('scale must be an integer between 0 and 18')
  }
  if (denominator === 0n) {
    return null
  }
  if (numerator < 0n || denominator < 0n) {
    throw new Error('numerator and denominator must be non-negative')
  }
  const factor = 10n ** BigInt(scale)
  const scaled = convertPointsToReferenceAtomic({
    pointsAtomic: numerator,
    referenceAtomicPerPointNumerator: factor,
    referenceAtomicPerPointDenominator: denominator,
    roundingMode: 'HALF_EVEN',
  })
  if (scale === 0) {
    return scaled.toString(10)
  }
  const whole = scaled / factor
  const fraction = scaled % factor
  return `${whole.toString(10)}.${fraction.toString(10).padStart(scale, '0')}`
}

export function formatRate(numerator: bigint, denominator: bigint): string | null {
  return formatFixedDecimal(numerator, denominator, RATE_DECIMAL_SCALE)
}

export function parseNonNegativeDecimalString(raw: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${field} must be a non-negative decimal string`)
  }
  return BigInt(raw)
}
