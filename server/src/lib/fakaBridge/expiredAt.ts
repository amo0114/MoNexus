/**
 * Parse Xboard user.expired_at from FakaBridge order-paid / order-status.
 * Xboard stores unix **seconds**; tolerate ms if a value is clearly large.
 */
export function parseFakaExpiredAt(value: unknown): Date | null {
  if (value == null || value === '') return null
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  // Heuristic: values below year ~2001 in ms are treated as seconds.
  const ms = n > 1e12 ? n : n * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  // Reject absurd far-past / far-future noise from bad payloads.
  const year = d.getUTCFullYear()
  if (year < 2000 || year > 2100) return null
  return d
}
