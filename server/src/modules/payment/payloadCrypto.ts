import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../../config/index.js'

const CIPHER = 'aes-256-gcm'
const IV_BYTES = 12

function encryptionKey(): Buffer | null {
  return config.recharge.eventEncryptionKey
}

/** Encrypts a raw provider payload. Returns null when no event key is configured. */
export function encryptPaymentEventPayload(raw: Buffer | string): string | null {
  const key = encryptionKey()
  if (!key) return null
  const plaintext = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

export function decryptPaymentEventPayload(ciphertext: string): Buffer {
  const key = encryptionKey()
  if (!key) throw new Error('PAYMENT_EVENT_ENCRYPTION_KEY is not configured')
  const [version, ivHex, tagHex, ctHex] = ciphertext.split(':')
  if (version !== 'v1' || !ivHex || !tagHex || !ctHex) {
    throw new Error('payment event ciphertext format invalid')
  }
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()])
}
