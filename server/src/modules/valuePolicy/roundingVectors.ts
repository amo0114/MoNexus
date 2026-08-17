/**
 * Shared HALF_EVEN vectors for money.ts and the PostgreSQL function
 * convert_points_to_reference_atomic. Every in-range result must match.
 */
export type HalfEvenVector = {
  name: string
  pointsAtomic: bigint
  numerator: bigint
  denominator: bigint
  expected: bigint
}

export const PG_INT8_MAX = 9223372036854775807n
export const PG_INT8_MIN = -9223372036854775808n

export const HALF_EVEN_VECTORS: readonly HalfEvenVector[] = [
  { name: 'even-tie-down-0.5', pointsAtomic: 1n, numerator: 1n, denominator: 2n, expected: 0n },
  { name: 'even-tie-down-2.5', pointsAtomic: 5n, numerator: 1n, denominator: 2n, expected: 2n },
  { name: 'odd-tie-up-1.5', pointsAtomic: 3n, numerator: 1n, denominator: 2n, expected: 2n },
  { name: 'odd-tie-up-3.5', pointsAtomic: 7n, numerator: 1n, denominator: 2n, expected: 4n },
  { name: 'non-tie-down-10/3', pointsAtomic: 10n, numerator: 1n, denominator: 3n, expected: 3n },
  { name: 'non-tie-up-11/3', pointsAtomic: 11n, numerator: 1n, denominator: 3n, expected: 4n },
  { name: 'exact-1200', pointsAtomic: 1200n, numerator: 1n, denominator: 1n, expected: 1200n },
  { name: 'above-max-safe-integer', pointsAtomic: (1n << 60n) + 1n, numerator: 1n, denominator: 1n, expected: (1n << 60n) + 1n },
  { name: 'pg-int8-max', pointsAtomic: PG_INT8_MAX, numerator: 1n, denominator: 1n, expected: PG_INT8_MAX },
]

// TypeScript bigint is unbounded; PostgreSQL must reject this as INT8 overflow.
export const HALF_EVEN_OVERFLOW_VECTOR = {
  name: 'pg-int8-overflow',
  pointsAtomic: PG_INT8_MAX,
  numerator: 2n,
  denominator: 1n,
} as const
