import { AmountParseError } from '../../../recharge/money.js'

/** VMQFox amounts are exact two-decimal CNY strings; never IEEE-754. */
export const VMQFOX_YUAN_SCALE = 2
const MINOR_PER_YUAN = 100n

export class VmqfoxAmountError extends AmountParseError {
  constructor(message: string) {
    super(message)
    this.name = 'VmqfoxAmountError'
  }
}

export function amountMinorToYuanString(amountMinor: bigint): string {
  if (typeof amountMinor !== 'bigint') {
    throw new VmqfoxAmountError('amountMinor must be a bigint')
  }
  if (amountMinor < 0n) {
    throw new VmqfoxAmountError('amountMinor must be non-negative')
  }
  const whole = amountMinor / MINOR_PER_YUAN
  const fraction = amountMinor % MINOR_PER_YUAN
  return `${whole.toString(10)}.${fraction.toString(10).padStart(VMQFOX_YUAN_SCALE, '0')}`
}

/**
 * Parse VMQFox price / reallyPrice. Only canonical `digits.dd` is accepted so
 * float rounding cannot sneak in.
 */
export function yuanStringToAmountMinor(value: string): bigint {
  if (typeof value !== 'string') {
    throw new VmqfoxAmountError('yuan amount must be a string')
  }
  if (value.length === 0) {
    throw new VmqfoxAmountError('yuan amount must not be empty')
  }
  if (/\s/.test(value) || value !== value.trim()) {
    throw new VmqfoxAmountError('whitespace is not allowed in yuan amounts')
  }
  if (/[eE]/.test(value)) {
    throw new VmqfoxAmountError('exponent notation is not allowed in yuan amounts')
  }
  if (value.startsWith('-') || value.startsWith('+')) {
    throw new VmqfoxAmountError('signed yuan amounts are not allowed')
  }
  if (!/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) {
    throw new VmqfoxAmountError('yuan amount must be a canonical two-decimal string')
  }
  const dot = value.indexOf('.')
  const whole = BigInt(value.slice(0, dot))
  const fraction = BigInt(value.slice(dot + 1))
  return whole * MINOR_PER_YUAN + fraction
}
