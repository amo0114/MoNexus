import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../../config/index.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
function aad(key: string, identity: string, settings: unknown) {
  return Buffer.from(JSON.stringify(['monexus:integration-credentials:v1', key, identity, canonical(settings)]))
}
export function encryptIntegrationCredentials(key: string, identity: string, settings: unknown, credentials: unknown): string {
  if (!config.integrationCredentialsEncKey) throw new Error('Integration encryption unavailable')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.integrationCredentialsEncKey, 'hex'), iv)
  cipher.setAAD(aad(key, identity, settings))
  const body = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()])
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join(':')
}
export function decryptIntegrationCredentials(key: string, identity: string, settings: unknown, ciphertext: string): unknown {
  if (!/^v1:[a-f0-9]{24}:[a-f0-9]{32}:(?:[a-f0-9]{2})+$/.test(ciphertext)) throw new Error('Invalid integration ciphertext')
  const [, iv, tag, body] = ciphertext.split(':')
  for (const root of [config.integrationCredentialsEncKey, config.integrationCredentialsEncKeyPrevious]) {
    if (!root) continue
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(root, 'hex'), Buffer.from(iv, 'hex'))
      decipher.setAAD(aad(key, identity, settings))
      decipher.setAuthTag(Buffer.from(tag, 'hex'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString('utf8'))
    } catch { /* Allow a controlled previous-root recovery, with no plaintext fallback. */ }
  }
  throw new Error('Integration credentials unavailable')
}
