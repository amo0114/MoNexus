import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../../config/index.js'

const AAD = Buffer.from('monexus:ai-api-key:v1')

function encryptionKey(): Buffer {
  if (!config.ai.credentialsEncKey) throw new Error('AI credential encryption unavailable')
  return Buffer.from(config.ai.credentialsEncKey, 'hex')
}

/** A dedicated server-side key; never derive production credentials from JWT material. */
export function encryptAiApiKey(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(AAD)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':')
}

export function decryptAiApiKey(value: string): string {
  if (!/^v1:[a-f0-9]{24}:[a-f0-9]{32}:(?:[a-f0-9]{2})+$/.test(value)) {
    throw new Error('AI credential ciphertext invalid')
  }
  const [, iv, tag, encrypted] = value.split(':')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'hex'))
  decipher.setAAD(AAD)
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8')
}
