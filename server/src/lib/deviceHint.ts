/**
 * Bounded, linear-time User-Agent reducer.
 *
 * Raw User-Agent headers are high-entropy fingerprinting data and can be
 * arbitrarily large. Every caller (RefreshToken summaries, SecurityEvent,
 * FileGrantLog) shares this single closed-vocabulary reducer so no raw UA
 * substring or backtracking regex ever enters storage or logs.
 */

export const DEFAULT_DEVICE_LABEL = '浏览器会话'
const MAX_UA_UTF8_BYTES = 512

const KNOWN_BROWSERS = new Set([
  'WeChat',
  'QQ',
  'Edge',
  'Opera',
  'Firefox',
  'Chrome',
  'Safari',
  'WebView',
  'Automated client',
  'Unknown browser',
])

const KNOWN_PLATFORMS = new Set([
  'iOS',
  'HarmonyOS',
  'Android',
  'ChromeOS',
  'Windows',
  'macOS',
  'Linux',
  'Unknown device',
])

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const buffer = Buffer.from(value, 'utf8')
  let end = maxBytes
  // Step back past any UTF-8 continuation bytes (10xxxxxx) so multi-byte
  // code points are never split mid-sequence.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1
  }
  return buffer.subarray(0, end).toString('utf8')
}

function isTokenBoundary(char: string | undefined): boolean {
  if (char === undefined) return true
  const code = char.charCodeAt(0)
  const isLowerAlpha = code >= 97 && code <= 122
  const isDigit = code >= 48 && code <= 57
  return !isLowerAlpha && !isDigit && char !== '_' && char !== '-'
}

/** Linear O(n) search for a token delimited by non-identifier characters. */
function hasBoundedToken(lower: string, token: string): boolean {
  let offset = 0
  while (offset <= lower.length - token.length) {
    const index = lower.indexOf(token, offset)
    if (index === -1) return false
    const before = index > 0 ? lower[index - 1] : undefined
    const after = index + token.length < lower.length ? lower[index + token.length] : undefined
    if (isTokenBoundary(before) && isTokenBoundary(after)) return true
    offset = index + 1
  }
  return false
}

/** Linear O(n) check for a prefix token (like `qq/`) starting on a boundary. */
function hasLeadingBoundedPrefix(lower: string, prefix: string): boolean {
  let offset = 0
  while (offset <= lower.length - prefix.length) {
    const index = lower.indexOf(prefix, offset)
    if (index === -1) return false
    const before = index > 0 ? lower[index - 1] : undefined
    if (isTokenBoundary(before)) return true
    offset = index + 1
  }
  return false
}

function hasSafariSignature(lower: string): boolean {
  let offset = 0
  while (offset < lower.length) {
    const versionIdx = lower.indexOf('version/', offset)
    if (versionIdx === -1) return false
    const afterPrefix = versionIdx + 'version/'.length
    if (afterPrefix < lower.length && lower[afterPrefix] !== ' ') {
      const safariIdx = lower.indexOf('safari/', afterPrefix)
      if (safariIdx !== -1) return true
    }
    offset = afterPrefix
  }
  return false
}

function detectPlatform(lower: string): string | null {
  if (lower.includes('ipad') || lower.includes('iphone') || lower.includes('ipod')) return 'iOS'
  if (lower.includes('harmonyos') || lower.includes('openharmony')) return 'HarmonyOS'
  if (lower.includes('android')) return 'Android'
  if (hasBoundedToken(lower, 'cros')) return 'ChromeOS'
  if (lower.includes('windows')) return 'Windows'
  if (lower.includes('macintosh') || lower.includes('mac os x')) return 'macOS'
  if (lower.includes('linux')) return 'Linux'
  return null
}

function detectBrowser(lower: string, platform: string | null): string | null {
  if (lower.includes('micromessenger/')) return 'WeChat'
  if (lower.includes('mqqbrowser/') || hasLeadingBoundedPrefix(lower, 'qq/')) return 'QQ'
  if (lower.includes('edg/') || lower.includes('edgios/') || lower.includes('edga/')) return 'Edge'
  if (lower.includes('opr/') || lower.includes('opt/')) return 'Opera'
  if (lower.includes('firefox/') || lower.includes('fxios/')) return 'Firefox'
  if (lower.includes('chrome/') || lower.includes('crios/')) return 'Chrome'
  if (hasSafariSignature(lower)) return 'Safari'
  if (platform === 'iOS' && lower.includes('applewebkit/') && !lower.includes('safari/')) return 'WebView'
  if (lower.includes('bot') || lower.includes('crawler') || lower.includes('spider')) return 'Automated client'
  return null
}

/**
 * Reduces a raw User-Agent header to a fixed `Browser · Platform` label, or
 * returns `null` when empty or neither browser nor platform is recognized.
 */
export function parseDeviceHint(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== 'string') return null
  const trimmed = userAgent.trim()
  if (trimmed.length === 0) return null

  const bounded = truncateUtf8Bytes(trimmed, MAX_UA_UTF8_BYTES)
  const lower = bounded.toLowerCase()
  const platform = detectPlatform(lower)
  const browser = detectBrowser(lower, platform)

  if (!browser && !platform) return null
  return `${browser ?? 'Unknown browser'} · ${platform ?? 'Unknown device'}`
}

/** Always returns a safe display label for user/admin views, falling back to Chinese. */
export function sessionDeviceLabel(userAgent: string | null | undefined): string {
  return parseDeviceHint(userAgent) ?? DEFAULT_DEVICE_LABEL
}

export const ALL_KNOWN_DEVICE_LABELS: readonly string[] = [
  DEFAULT_DEVICE_LABEL,
  ...[...KNOWN_BROWSERS].flatMap(browser =>
    [...KNOWN_PLATFORMS]
      .filter(platform => !(browser === 'Unknown browser' && platform === 'Unknown device'))
      .map(platform => `${browser} · ${platform}`),
  ),
]

/**
 * Recognizes values already produced by this closed-vocabulary reducer so
 * historical backfills and read-side fallbacks are strictly idempotent.
 */
export function isKnownDeviceLabel(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  if (value === DEFAULT_DEVICE_LABEL) return true
  const parts = value.split(' · ')
  if (parts.length !== 2) return false
  const [browser, platform] = parts as [string, string]
  if (!KNOWN_BROWSERS.has(browser) || !KNOWN_PLATFORMS.has(platform)) return false
  return !(browser === 'Unknown browser' && platform === 'Unknown device')
}

/** Idempotently normalizes a persisted label or raw legacy UA string. */
export function normalizeStoredDeviceLabel(value: string | null | undefined): string {
  if (isKnownDeviceLabel(value)) return value as string
  return sessionDeviceLabel(value)
}
