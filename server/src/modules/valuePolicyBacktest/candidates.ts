import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'
import { gcd } from './gcd.js'
import { CNY_ATOMIC_PER_MAJOR, ROUNDING_MODE } from './thresholds.js'

export type NormalizedCandidate = {
  pointsPerCnyMajor: number
  numerator: bigint
  denominator: bigint
  roundingMode: typeof ROUNDING_MODE
}

export function normalizeCandidate(pointsPerCnyMajor: number): NormalizedCandidate {
  if (!Number.isInteger(pointsPerCnyMajor) || pointsPerCnyMajor <= 0 || pointsPerCnyMajor > 1_000_000) {
    throw new BacktestError(
      BACKTEST_ERROR_CODES.INVALID_CANDIDATE,
      'candidate must be a positive integer points-per-CNY-major value at most 1000000',
      { field: 'candidates' },
    )
  }
  const n = BigInt(pointsPerCnyMajor)
  const divisor = gcd(CNY_ATOMIC_PER_MAJOR, n)
  return {
    pointsPerCnyMajor,
    numerator: CNY_ATOMIC_PER_MAJOR / divisor,
    denominator: n / divisor,
    roundingMode: ROUNDING_MODE,
  }
}

export function parseCandidateList(raw: string): number[] {
  const parts = raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length === 0) {
    throw new BacktestError(
      BACKTEST_ERROR_CODES.INVALID_CANDIDATE,
      'candidates must be a non-empty comma-separated list of positive integers',
    )
  }
  const values: number[] = []
  const seen = new Set<number>()
  for (const part of parts) {
    if (!/^[1-9][0-9]*$/.test(part)) {
      throw new BacktestError(
        BACKTEST_ERROR_CODES.INVALID_CANDIDATE,
        'candidates must be positive decimal integers',
      )
    }
    const value = Number(part)
    if (!Number.isSafeInteger(value)) {
      throw new BacktestError(
        BACKTEST_ERROR_CODES.INVALID_CANDIDATE,
        'candidate exceeds the safe integer range',
      )
    }
    normalizeCandidate(value)
    if (seen.has(value)) {
      throw new BacktestError(
        BACKTEST_ERROR_CODES.INVALID_CANDIDATE,
        'candidates must not contain duplicates',
      )
    }
    seen.add(value)
    values.push(value)
  }
  return values
}

export function serializeCandidate(candidate: NormalizedCandidate) {
  return {
    pointsPerCnyMajor: candidate.pointsPerCnyMajor,
    numerator: candidate.numerator.toString(10),
    denominator: candidate.denominator.toString(10),
    roundingMode: candidate.roundingMode,
    label: `${candidate.pointsPerCnyMajor} PTS = 1 CNY`,
  }
}
