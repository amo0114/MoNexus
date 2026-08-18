export const BACKTEST_ERROR_CODES = {
  UNKNOWN_SCHEMA_VERSION: 'UNKNOWN_SCHEMA_VERSION',
  INVALID_JSON: 'INVALID_JSON',
  JSON_NUMBER_AMOUNT: 'JSON_NUMBER_AMOUNT',
  NEGATIVE_AMOUNT: 'NEGATIVE_AMOUNT',
  NON_DECIMAL_AMOUNT: 'NON_DECIMAL_AMOUNT',
  DUPLICATE_REF: 'DUPLICATE_REF',
  ORPHAN_OFFER_REF: 'ORPHAN_OFFER_REF',
  ORPHAN_ACCOUNT_REF: 'ORPHAN_ACCOUNT_REF',
  INVALID_PERIOD: 'INVALID_PERIOD',
  INVALID_MONTH: 'INVALID_MONTH',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  TOO_MANY_ROWS: 'TOO_MANY_ROWS',
  MISSING_INPUT: 'MISSING_INPUT',
  INVALID_CANDIDATE: 'INVALID_CANDIDATE',
  UNSUPPORTED_REFERENCE_ASSET: 'UNSUPPORTED_REFERENCE_ASSET',
  OUTPUT_EXISTS: 'OUTPUT_EXISTS',
  INVALID_GATES_CONFIG: 'INVALID_GATES_CONFIG',
  INVALID_CLI: 'INVALID_CLI',
  IDENTIFIER_NOT_PSEUDONYMOUS: 'IDENTIFIER_NOT_PSEUDONYMOUS',
  INPUT_INCONSISTENT: 'INPUT_INCONSISTENT',
  UNVERIFIABLE_SOURCE: 'UNVERIFIABLE_SOURCE',
} as const

export type BacktestErrorCode = (typeof BACKTEST_ERROR_CODES)[keyof typeof BACKTEST_ERROR_CODES]

export class BacktestError extends Error {
  readonly code: BacktestErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: BacktestErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'BacktestError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export function isBacktestError(error: unknown): error is BacktestError {
  return error instanceof BacktestError
}
