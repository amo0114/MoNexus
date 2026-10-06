// SPEC-AI-PRODUCT-001 §7.4 / §7.5 — deterministic extraction used by the
// validator. Semantic normalisation (「三十天」 = 「30 日」, 「100G」 =
// 「100GB」, 「美区」 = 「美国」), not substring matching against the input.

import {
  PLATFORM_LEXICON,
  PROMISE_TERMS,
  REGION_LEXICON,
  TIMING_TERMS,
  UNBOUNDED_TERMS,
} from './lexicon.js'

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

const NUMBER = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)'

export function parseNumberToken(token: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token)
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(token)) return null
  let total = 0
  let section = 0
  let digit: number | null = null
  for (const ch of token) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]
    } else if (ch in CN_SMALL_UNITS) {
      section += (digit ?? 1) * CN_SMALL_UNITS[ch]
      digit = null
    } else if (ch === '万') {
      total += (section + (digit ?? 0)) * 10_000
      section = 0
      digit = null
    }
  }
  return total + section + (digit ?? 0)
}

/** Collapse whitespace so spans and mentions are compared on the same text. */
export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export type DurationExpr =
  | { kind: 'days'; days: number }
  | { kind: 'months'; months: number }
  | { kind: 'minutes'; minutes: number }

export type Mention = { start: number; end: number; text: string }

const DURATION_RE = new RegExp(
  // Bare 「分」 is deliberately absent: 「十分简单」 would read as ten minutes.
  `(?:(${NUMBER})\\s*个?\\s*(个月|星期|季度|小时|钟头|分钟|天|日|周|月|季|年)|半\\s*个?\\s*(年|个月|月|小时))`,
  'g',
)

function durationFrom(value: number, unit: string): DurationExpr {
  switch (unit) {
    case '天':
    case '日':
      return { kind: 'days', days: value }
    case '周':
    case '星期':
      return { kind: 'days', days: value * 7 }
    case '个月':
    case '月':
      return { kind: 'months', months: value }
    case '季':
    case '季度':
      return { kind: 'months', months: value * 3 }
    case '年':
      return { kind: 'months', months: value * 12 }
    case '小时':
    case '钟头':
      return { kind: 'minutes', minutes: value * 60 }
    default:
      // 分钟
      return { kind: 'minutes', minutes: value }
  }
}

export function findDurations(text: string): Array<Mention & { expr: DurationExpr }> {
  const out: Array<Mention & { expr: DurationExpr }> = []
  for (const match of text.matchAll(DURATION_RE)) {
    const start = match.index ?? 0
    if (match[3]) {
      out.push({ start, end: start + match[0].length, text: match[0], expr: durationFrom(0.5, match[3]) })
      continue
    }
    const value = parseNumberToken(match[1])
    if (value == null) continue
    out.push({ start, end: start + match[0].length, text: match[0], expr: durationFrom(value, match[2]) })
  }
  return out
}

// Non-time quantities. Latin units must not be followed by a Latin letter.
const QUANTITY_UNITS: Array<[string, string]> = [
  ['Gbps', 'Gbps'], ['Mbps', 'Mbps'], ['Kbps', 'Kbps'],
  ['TB', 'TB'], ['GB', 'GB'], ['MB', 'MB'], ['KB', 'KB'],
  ['T', 'TB'], ['G', 'GB'], ['M', 'MB'], ['B', 'B'], ['兆', 'MB'],
  ['个设备', 'device'], ['设备', 'device'], ['终端', 'device'], ['台', 'device'],
  ['个账号', 'account'], ['账号', 'account'],
  ['人', 'person'], ['位', 'person'],
  ['次', 'times'], ['积分', 'points'], ['元', 'yuan'], ['块', 'yuan'],
  ['%', 'percent'], ['％', 'percent'],
]

const QUANTITY_RE = new RegExp(
  `(${NUMBER})\\s*(${QUANTITY_UNITS.map(([unit]) => unit).join('|')})(?![A-Za-z])`,
  'gi',
)
const MONEY_PREFIX_RE = new RegExp(`[¥￥$]\\s*(${NUMBER})`, 'g')

export type QuantityTuple = { value: number; unit: string }

function canonicalQuantityUnit(raw: string): string | null {
  const exact = QUANTITY_UNITS.find(([unit]) => unit === raw)
  if (exact) return exact[1]
  const insensitive = QUANTITY_UNITS.find(([unit]) => /[A-Za-z]/.test(unit) && unit.toLowerCase() === raw.toLowerCase())
  return insensitive ? insensitive[1] : null
}

// 「一次性」「每一位用户」「一人一号」 are idiom, not quantity facts.
const IDIOMATIC_ONE_UNITS = new Set(['times', 'person'])

export function findQuantities(text: string): Array<Mention & { tuple: QuantityTuple }> {
  const out: Array<Mention & { tuple: QuantityTuple }> = []
  for (const match of text.matchAll(QUANTITY_RE)) {
    const value = parseNumberToken(match[1])
    const unit = canonicalQuantityUnit(match[2])
    if (value == null || unit == null) continue
    if (match[1] === '一' && IDIOMATIC_ONE_UNITS.has(unit)) continue
    const start = match.index ?? 0
    out.push({ start, end: start + match[0].length, text: match[0], tuple: { value, unit } })
  }
  for (const match of text.matchAll(MONEY_PREFIX_RE)) {
    const value = parseNumberToken(match[1])
    if (value == null) continue
    const start = match.index ?? 0
    out.push({ start, end: start + match[0].length, text: match[0], tuple: { value, unit: 'money' } })
  }
  return out
}

/** Comparable (value, unit) tuples, including durations, for declared-text restatement checks. */
export function extractTuples(text: string): QuantityTuple[] {
  const tuples: QuantityTuple[] = findQuantities(text).map(item => item.tuple)
  for (const item of findDurations(text)) {
    const expr = item.expr
    tuples.push(
      expr.kind === 'days'
        ? { value: expr.days, unit: 'day' }
        : expr.kind === 'months'
          ? { value: expr.months, unit: 'month' }
          : { value: expr.minutes, unit: 'minute' },
    )
  }
  return tuples
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termMentions(text: string, terms: readonly string[]): Mention[] {
  const out: Mention[] = []
  const sorted = [...terms].sort((a, b) => b.length - a.length)
  const re = new RegExp(sorted.map(escapeRegExp).join('|'), 'g')
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0
    out.push({ start, end: start + match[0].length, text: match[0] })
  }
  return out
}

type LexiconEntry = (typeof REGION_LEXICON)[number]

function lexiconMentions(text: string, lexicon: LexiconEntry[]): Array<Mention & { id: string }> {
  const out: Array<Mention & { id: string }> = []
  for (const entry of lexicon) {
    const patterns: RegExp[] = []
    if (entry.zh.length > 0) patterns.push(new RegExp(entry.zh.map(escapeRegExp).join('|'), 'g'))
    if (entry.latin.length > 0) {
      patterns.push(new RegExp(`(?<![A-Za-z])(?:${entry.latin.map(escapeRegExp).join('|')})(?![A-Za-z])`, 'gi'))
    }
    if (entry.latinCaseSensitive && entry.latinCaseSensitive.length > 0) {
      patterns.push(new RegExp(`(?<![A-Za-z])(?:${entry.latinCaseSensitive.map(escapeRegExp).join('|')})(?![A-Za-z])`, 'g'))
    }
    for (const re of patterns) {
      for (const match of text.matchAll(re)) {
        const start = match.index ?? 0
        out.push({ start, end: start + match[0].length, text: match[0], id: entry.id })
      }
    }
  }
  return out
}

export function findRegionPlatformMentions(text: string): Array<Mention & { id: string }> {
  return [...lexiconMentions(text, REGION_LEXICON), ...lexiconMentions(text, PLATFORM_LEXICON)]
}

export function regionPlatformIds(text: string): Set<string> {
  return new Set(findRegionPlatformMentions(text).map(item => item.id))
}

export type HardFactClass = 'H1' | 'H2' | 'H3' | 'H4' | 'H5'

/** §7.4 detector: every hard-fact mention in a unit, with its class. */
export function detectHardFacts(text: string): Array<Mention & { cls: HardFactClass }> {
  return [
    ...findDurations(text).map(item => ({ ...item, cls: 'H1' as const })),
    ...findQuantities(text).map(item => ({ ...item, cls: 'H1' as const })),
    ...termMentions(text, UNBOUNDED_TERMS).map(item => ({ ...item, cls: 'H2' as const })),
    ...termMentions(text, TIMING_TERMS).map(item => ({ ...item, cls: 'H3' as const })),
    ...termMentions(text, PROMISE_TERMS).map(item => ({ ...item, cls: 'H4' as const })),
    ...findRegionPlatformMentions(text).map(item => ({ ...item, cls: 'H5' as const })),
  ]
}

export function findUnboundedTerms(text: string): Mention[] {
  return termMentions(text, UNBOUNDED_TERMS)
}

export function findPromiseTerms(text: string): Mention[] {
  return termMentions(text, PROMISE_TERMS)
}

/** §7.1-4: markup, links, URLs, e-mail and phone numbers are not allowed in V1 plain-text output. */
export function hasForbiddenMarkup(text: string): boolean {
  return /<[^>]+>/.test(text)
    || /\[[^\]]*\]\([^)]*\)/.test(text)
    || /https?:\/\/|www\./i.test(text)
    || /[\w.+-]+@[\w-]+\.[\w.]+/.test(text)
    || /(?<!\d)1[3-9]\d{9}(?!\d)/.test(text)
    || /(?<!\d)\d{3,4}-\d{7,8}(?!\d)/.test(text)
}
