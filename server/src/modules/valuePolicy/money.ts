export type RoundingMode = 'HALF_EVEN'

export interface ConvertPointsInput {
  pointsAtomic: bigint
  referenceAtomicPerPointNumerator: bigint
  referenceAtomicPerPointDenominator: bigint
  roundingMode: RoundingMode
}

function assertBigint(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint') {
    throw new Error(`${field} must be a bigint`)
  }
}

/**
 * Deterministic points → reference atomic conversion.
 * Intermediate arithmetic is BigInt only. Non-exact quotients use HALF_EVEN.
 */
export function convertPointsToReferenceAtomic(input: ConvertPointsInput): bigint {
  assertBigint(input.pointsAtomic, 'pointsAtomic')
  assertBigint(input.referenceAtomicPerPointNumerator, 'referenceAtomicPerPointNumerator')
  assertBigint(input.referenceAtomicPerPointDenominator, 'referenceAtomicPerPointDenominator')

  if (input.pointsAtomic < 0n) {
    throw new Error('pointsAtomic must be non-negative')
  }
  if (input.referenceAtomicPerPointNumerator <= 0n) {
    throw new Error('referenceAtomicPerPointNumerator must be positive')
  }
  if (input.referenceAtomicPerPointDenominator <= 0n) {
    throw new Error('referenceAtomicPerPointDenominator must be positive')
  }
  if (input.roundingMode !== 'HALF_EVEN') {
    throw new Error('roundingMode must be HALF_EVEN')
  }

  const product = input.pointsAtomic * input.referenceAtomicPerPointNumerator
  const denominator = input.referenceAtomicPerPointDenominator
  const quotient = product / denominator
  const remainder = product % denominator

  let result = quotient
  if (remainder !== 0n) {
    const doubleRemainder = remainder * 2n
    if (doubleRemainder > denominator) {
      result = quotient + 1n
    } else if (doubleRemainder === denominator && quotient % 2n !== 0n) {
      result = quotient + 1n
    }
  }

  if (result < 0n) {
    throw new Error('reference amount must be non-negative')
  }
  return result
}

export function atomicToDecimalString(amount: bigint): string {
  if (typeof amount !== 'bigint') {
    throw new Error('amount must be a bigint')
  }
  if (amount < 0n) {
    throw new Error('amount must be non-negative')
  }
  return amount.toString(10)
}
