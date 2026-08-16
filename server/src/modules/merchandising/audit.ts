const MAX_AUDIT_REASON_CHARS = 64

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi
const CREDENTIAL_PATTERN = /\b(token|secret|password|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi

/**
 * Keep operator-provided reasons useful in the private business row while
 * ensuring AdminLog never stores arbitrary long text or credential-shaped
 * material. The length marker preserves auditability without copying the
 * entire reason into the log stream.
 */
export function summarizeAdminAuditReason(reason: string): string {
  const normalized = reason
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EMAIL_PATTERN, '[email]')
    .replace(BEARER_PATTERN, '[token]')
    .replace(CREDENTIAL_PATTERN, '$1=[redacted]')

  const chars = Array.from(normalized)
  if (chars.length <= MAX_AUDIT_REASON_CHARS) {
    return `reason=${normalized || '[empty]'}`
  }

  return `reason=${chars.slice(0, MAX_AUDIT_REASON_CHARS).join('')}…;reasonTruncated=true`
}
