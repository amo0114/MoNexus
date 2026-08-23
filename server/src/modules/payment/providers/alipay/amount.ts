import { AmountParseError } from '../../../recharge/money.js'

/** Alipay V1 only accepts ISO currencies whose minor-unit scale is exactly 2. */
export const ALIPAY_YUAN_SCALE = 2
const MINOR_PER_YUAN = 100n

export class AlipayAmountError extends AmountParseError {
  constructor(message: string) {
    super(message)
    this.name = 'AlipayAmountError'
  }
}

/**
 * Convert platform amountMinor (fen) to Alipay total_amount.
 * Alipay requires a two-decimal yuan string; IEEE-754 would drop 0.01/0.10.
 */
export function amountMinorToYuanString(amountMinor: bigint): string {
  if (typeof amountMinor !== 'bigint') {
    throw new AlipayAmountError('amountMinor must be a bigint')
  }
  if (amountMinor < 0n) {
    throw new AlipayAmountError('amountMinor must be non-negative')
  }
  const whole = amountMinor / MINOR_PER_YUAN
  const fraction = amountMinor % MINOR_PER_YUAN
  return `${whole.toString(10)}.${fraction.toString(10).padStart(ALIPAY_YUAN_SCALE, '0')}`
}

/**
 * Parse Alipay total_amount / refund_amount back to amountMinor.
 * Only the canonical `digits.dd` form is accepted so float rounding cannot sneak in.
 */
export function yuanStringToAmountMinor(value: string): bigint {
  if (typeof value !== 'string') {
    throw new AlipayAmountError('yuan amount must be a string')
  }
  if (value.length === 0) {
    throw new AlipayAmountError('yuan amount must not be empty')
  }
  if (/\s/.test(value) || value !== value.trim()) {
    throw new AlipayAmountError('whitespace is not allowed in yuan amounts')
  }
  if (/[eE]/.test(value)) {
    throw new AlipayAmountError('exponent notation is not allowed in yuan amounts')
  }
  if (value.startsWith('-') || value.startsWith('+')) {
    throw new AlipayAmountError('signed yuan amounts are not allowed')
  }
  if (!/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) {
    throw new AlipayAmountError('yuan amount must be a canonical two-decimal string')
  }
  const dot = value.indexOf('.')
  const whole = BigInt(value.slice(0, dot))
  const fraction = BigInt(value.slice(dot + 1))
  return whole * MINOR_PER_YUAN + fraction
}

export function isFullRefundAmount(totalYuan: string, refundYuan: string): boolean {
  return yuanStringToAmountMinor(totalYuan) === yuanStringToAmountMinor(refundYuan)
}
