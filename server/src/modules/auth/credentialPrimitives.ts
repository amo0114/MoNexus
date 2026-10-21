import crypto from 'crypto'

export const PASSWORD_BCRYPT_ROUNDS = 12

export function normalizeEmailAddress(email: string) {
  return email.trim().toLowerCase()
}

export function hashAuthToken(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function generateAuthToken() {
  return crypto.randomBytes(32).toString('hex')
}
