import { createHash } from 'node:crypto'

/**
 * The one documented statement format accepted for import. Provider-specific
 * official bill formats must be mapped into this shape before upload; no other
 * format is claimed to be supported.
 *
 *   provider_entry_key,provider_payment_id,status,amount_minor,currency,occurred_at
 *
 * amount_minor is an integer in the currency's minor unit; occurred_at is an
 * ISO-8601 timestamp with offset. The period is half-open [periodStart, periodEnd).
 */
export const STATEMENT_FORMAT_VERSION = 'monexus-statement-v1'
export const STATEMENT_HEADER = 'provider_entry_key,provider_payment_id,status,amount_minor,currency,occurred_at'
export const STATEMENT_MAX_ROWS = 5000
const STATUSES = new Set(['succeeded', 'paid', 'failed', 'refunded', 'pending'])

export type StatementEntry = {
  line: number
  providerEntryKey: string
  providerPaymentId: string | null
  status: string
  amountMinor: bigint
  currency: string
  occurredAt: Date
}

export type ParsedStatement = {
  formatVersion: typeof STATEMENT_FORMAT_VERSION
  sha256: string
  entries: StatementEntry[]
  invalid: Array<{ line: number; error: string }>
  duplicates: number[]
  totals: Record<string, string>
}

export function parseStatementCsv(text: string, period: { start: Date; end: Date }): ParsedStatement {
  const sha256 = createHash('sha256').update(text).digest('hex')
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== STATEMENT_HEADER) {
    return { formatVersion: STATEMENT_FORMAT_VERSION, sha256, entries: [], invalid: [{ line: 1, error: '表头不符合 monexus-statement-v1' }], duplicates: [], totals: {} }
  }
  const entries: StatementEntry[] = []
  const invalid: ParsedStatement['invalid'] = []
  const duplicates: number[] = []
  const seen = new Set<string>()
  const totals = new Map<string, bigint>()

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (!raw) continue
    const line = i + 1
    if (entries.length + invalid.length >= STATEMENT_MAX_ROWS) {
      invalid.push({ line, error: `超过单文件 ${STATEMENT_MAX_ROWS} 行上限` })
      break
    }
    const cols = raw.split(',').map(col => col.trim())
    if (cols.length !== 6) { invalid.push({ line, error: '列数必须为 6' }); continue }
    const [key, paymentId, status, amount, currency, occurred] = cols
    const occurredAt = new Date(occurred)
    if (!key || key.length > 128) { invalid.push({ line, error: 'provider_entry_key 无效' }); continue }
    if (!STATUSES.has(status)) { invalid.push({ line, error: 'status 无效' }); continue }
    if (!/^\d{1,18}$/.test(amount)) { invalid.push({ line, error: 'amount_minor 必须为非负整数' }); continue }
    if (!/^[A-Z]{3}$/.test(currency)) { invalid.push({ line, error: 'currency 必须为 3 位大写代码' }); continue }
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(occurred) || Number.isNaN(occurredAt.getTime())) {
      invalid.push({ line, error: 'occurred_at 必须为带时区的 ISO 时间' }); continue
    }
    if (occurredAt < period.start || occurredAt >= period.end) { invalid.push({ line, error: '超出账单区间' }); continue }
    if (seen.has(key)) { duplicates.push(line); continue }
    seen.add(key)
    const amountMinor = BigInt(amount)
    totals.set(currency, (totals.get(currency) ?? 0n) + amountMinor)
    entries.push({ line, providerEntryKey: key, providerPaymentId: paymentId || null, status, amountMinor, currency, occurredAt })
  }
  return {
    formatVersion: STATEMENT_FORMAT_VERSION,
    sha256,
    entries,
    invalid,
    duplicates,
    totals: Object.fromEntries([...totals].map(([currency, sum]) => [currency, sum.toString()])),
  }
}
