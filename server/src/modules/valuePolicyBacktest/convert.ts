import { convertPointsToReferenceAtomic } from '../valuePolicy/money.js'
import type { NormalizedCandidate } from './candidates.js'
import { formatCnyFromAtomic } from './format.js'

export function convertPoints(points: bigint, candidate: NormalizedCandidate): bigint {
  return convertPointsToReferenceAtomic({
    pointsAtomic: points,
    referenceAtomicPerPointNumerator: candidate.numerator,
    referenceAtomicPerPointDenominator: candidate.denominator,
    roundingMode: 'HALF_EVEN',
  })
}

export function isExactConversion(points: bigint, candidate: NormalizedCandidate): boolean {
  return (points * candidate.numerator) % candidate.denominator === 0n
}

export function roundingDeltaAtomic(points: bigint, candidate: NormalizedCandidate): bigint {
  const product = points * candidate.numerator
  const truncated = product / candidate.denominator
  return convertPoints(points, candidate) - truncated
}

export function convertAndFormat(points: bigint, candidate: NormalizedCandidate): {
  atomic: bigint
  atomicText: string
  cny: string
} {
  const atomic = convertPoints(points, candidate)
  return {
    atomic,
    atomicText: atomic.toString(10),
    cny: formatCnyFromAtomic(atomic),
  }
}

export function formatSignedCnyFromAtomic(atomic: bigint): string {
  if (atomic < 0n) {
    return `-${formatCnyFromAtomic(-atomic)}`
  }
  return formatCnyFromAtomic(atomic)
}

export function formatSignedDecimal(value: bigint): string {
  return value.toString(10)
}
