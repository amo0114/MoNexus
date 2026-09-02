import type { VmqfoxPaymentMethod } from './config.js'

export const VMQFOX_PAY_URL_MAX_CHARS = 2048
const WXP_PREFIX = 'wxp:'
const ALIPAY_HOST = 'qr.alipay.com'
const ALIPAY_HTTPS_PREFIX = `https://${ALIPAY_HOST}`

function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Return the original string when it is an allowlisted native payUrl.
 * Never trim-then-accept: padded or control-bearing input is rejected.
 */
export function validateVmqfoxPayUrl(method: VmqfoxPaymentMethod, raw: string): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length < 1 || raw.length > VMQFOX_PAY_URL_MAX_CHARS) return null
  if (raw.trim() !== raw) return null
  if (hasAsciiControl(raw)) return null

  if (method === 'wechat') {
    if (!raw.startsWith(WXP_PREFIX)) return null
    const rest = raw.slice(WXP_PREFIX.length)
    if (rest.length === 0) return null
    if (/\s/u.test(rest)) return null
    return raw
  }

  if (method !== 'alipay') return null
  if (/\s/u.test(raw)) return null
  if (raw.includes('#')) return null
  if (!raw.startsWith(ALIPAY_HTTPS_PREFIX)) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.port !== '') return null
  if (parsed.hash !== '') return null
  if (parsed.hostname !== ALIPAY_HOST) return null
  return raw
}
