import { getIsoCurrencyMetadata } from '../../../recharge/money.js'
import type { RechargeCurrency } from '../../../recharge/types.js'

export class PaypalAmountError extends Error {
  readonly code = 'PAYPAL_AMOUNT_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'PaypalAmountError'
  }
}

/** PayPal `value` is a decimal string; never IEEE-754. */
export function minorToPaypalValue(amountMinor: bigint, currency: string): string {
  if (typeof amountMinor !== 'bigint' || amountMinor < 0n) {
    throw new PaypalAmountError('amountMinor must be a non-negative bigint')
  }
  const scale = getIsoCurrencyMetadata(currency).scale
  const base = 10n ** BigInt(scale)
  const whole = amountMinor / base
  const fraction = amountMinor % base
  if (scale === 0) return whole.toString(10)
  return `${whole.toString(10)}.${fraction.toString(10).padStart(scale, '0')}`
}

export function paypalValueToMinor(value: string, currency: string): bigint {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PaypalAmountError('paypal amount value is required')
  }
  if (/\s/.test(value) || value !== value.trim() || /[eE+]/.test(value) || value.startsWith('-')) {
    throw new PaypalAmountError('paypal amount value is not canonical')
  }
  const scale = getIsoCurrencyMetadata(currency).scale
  if (scale === 0) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new PaypalAmountError('paypal amount value is not a whole number')
    }
    return BigInt(value)
  }
  const match = value.match(/^(0|[1-9][0-9]*)\.([0-9]+)$/)
  if (!match || match[2].length !== scale) {
    throw new PaypalAmountError('paypal amount value scale mismatch')
  }
  const base = 10n ** BigInt(scale)
  return BigInt(match[1]) * base + BigInt(match[2])
}

export function assertSupportedPaypalCurrency(currency: string): asserts currency is RechargeCurrency {
  getIsoCurrencyMetadata(currency)
}
