/**
 * Derive Xboard period from externalSku.
 * Named: aster-pro-half-yearly → half_yearly
 * Alias: plan-4-reset_traffic → reset_traffic
 */
const NAMED_SUFFIX: Array<[RegExp, string]> = [
  [/-three-yearly$/, 'three_yearly'],
  [/-two-yearly$/, 'two_yearly'],
  [/-half-yearly$/, 'half_yearly'],
  [/-quarterly$/, 'quarterly'],
  [/-yearly$/, 'yearly'],
  [/-monthly$/, 'monthly'],
  [/-onetime$/, 'onetime'],
  [/-reset-traffic$/, 'reset_traffic'],
  [/-reset_traffic$/, 'reset_traffic'],
]

export function periodFromFakaSku(sku: string, fallback = 'monthly'): string {
  const s = sku.trim().toLowerCase()
  if (!s) return fallback

  const plan = s.match(/^plan-\d+-(.+)$/)
  if (plan?.[1]) {
    // plan aliases already use underscores
    return plan[1]
  }

  for (const [re, period] of NAMED_SUFFIX) {
    if (re.test(s)) return period
  }
  return fallback
}
