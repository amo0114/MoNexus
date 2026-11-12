import { randomBytes } from 'node:crypto'
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Internal keys and provider order references are deliberately unaffected. */
export function businessNumber(prefix: 'MN' | 'MNSB' | 'MNAS', createdAt = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(createdAt)
    .replaceAll('-', '')
  const suffix = [...randomBytes(12)].map((b) => alphabet[b & 31]).join('')
  return `${prefix}${day}-${suffix}`
}
