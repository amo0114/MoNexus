export const RECHARGE_CURRENCIES = ['CNY', 'USD'] as const
export type RechargeCurrency = (typeof RECHARGE_CURRENCIES)[number]

/** Display metadata only. Server min/max/step remain the authority. */
export const CURRENCY_DISPLAY = {
  CNY: { scale: 2, symbol: '¥' },
  USD: { scale: 2, symbol: '$' },
} as const

export function currencyScale(currency: string): number {
  if (currency === 'CNY' || currency === 'USD') return CURRENCY_DISPLAY[currency].scale
  return 2
}

export function currencySymbol(currency: string): string {
  if (currency === 'CNY' || currency === 'USD') return CURRENCY_DISPLAY[currency].symbol
  return `${currency} `
}

function isCanonicalMinor(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value)
}

export function compareMinor(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export function amountFitsStep(amountMinor: string, stepMinor: string): boolean {
  if (!isCanonicalMinor(amountMinor) || !isCanonicalMinor(stepMinor)) return false
  const step = BigInt(stepMinor)
  if (step <= 0n) return true
  return BigInt(amountMinor) % step === 0n
}

export type AmountParseFailure = 'empty' | 'incomplete' | 'format' | 'decimals'

export type AmountParseResult =
  | { ok: true; minor: string }
  | { ok: false; reason: AmountParseFailure }

/**
 * Parse a user-typed major-unit string into a decimal minor-unit string.
 * Intermediate input such as "1." is incomplete, not a floor check.
 */
export function parseMajorInput(raw: string, scale: number): AmountParseResult {
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'empty' }
  if (value.endsWith('.')) return { ok: false, reason: 'incomplete' }
  if (/\s/.test(raw) || /[eE+\-]/.test(value)) return { ok: false, reason: 'format' }
  if (!/^\d+(\.\d+)?$/.test(value)) return { ok: false, reason: 'format' }
  const [wholeRaw, fracRaw = ''] = value.split('.')
  if (fracRaw.length > scale) return { ok: false, reason: 'decimals' }
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0'
  const frac = fracRaw.padEnd(scale, '0')
  const combined = `${whole}${frac}`.replace(/^0+(?=\d)/, '')
  return { ok: true, minor: combined }
}

export function formatMinorUnits(amountMinor: string, scale: number): string {
  const digits = isCanonicalMinor(amountMinor) ? amountMinor : '0'
  const padded = digits.padStart(scale + 1, '0')
  const whole = padded.slice(0, padded.length - scale)
  const frac = padded.slice(padded.length - scale)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${grouped}.${frac}`
}

export function formatCurrencyAmount(amountMinor: string, currency: string): string {
  return `${currencySymbol(currency)}${formatMinorUnits(amountMinor, currencyScale(currency))}`
}

export function formatPoints(points: string): string {
  if (!isCanonicalMinor(points)) return points
  return BigInt(points).toLocaleString('en-US')
}

export type AmountBoundError = 'below_min' | 'above_max' | 'step'

export function validateAmountBounds(
  amountMinor: string,
  bounds: { minAmountMinor: string; maxAmountMinor: string; amountStepMinor: string },
): AmountBoundError | null {
  if (!isCanonicalMinor(amountMinor)) return 'below_min'
  if (compareMinor(amountMinor, bounds.minAmountMinor) < 0) return 'below_min'
  if (compareMinor(amountMinor, bounds.maxAmountMinor) > 0) return 'above_max'
  if (!amountFitsStep(amountMinor, bounds.amountStepMinor)) return 'step'
  return null
}
