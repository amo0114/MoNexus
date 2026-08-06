import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../../config/index.js'

/**
 * SPEC-STORAGE-001：对象存储 AK/SK 信封。
 * 密文格式 `v{n}:<iv>:<tag>:<ct>`（hex）。
 * 解密按密文 version 选密钥环：当前 STORAGE_CREDENTIALS_ENC_KEY + 可选 PREV。
 */

const CIPHER = 'aes-256-gcm'
const IV_BYTES = 12

export interface StorageCredentials {
  accessKey: string
  secretKey: string
}

function deriveDevKey(): Buffer {
  return createHash('sha256').update(`storage-credentials-enc:${config.jwtSecret}`).digest()
}

function keyForVersion(version: number): Buffer | null {
  const currentVersion = config.storageCredentialsEncKeyVersion
  if (version === currentVersion) {
    if (config.storageCredentialsEncKey) {
      return Buffer.from(config.storageCredentialsEncKey, 'hex')
    }
    return deriveDevKey()
  }
  // Previous key ring entry
  if (
    config.storageCredentialsEncKeyPrevious
    && config.storageCredentialsEncKeyPreviousVersion === version
  ) {
    return Buffer.from(config.storageCredentialsEncKeyPrevious, 'hex')
  }
  // Dev-only: derived key only valid for current version path above
  return null
}

export function storageCredentialsKeyVersion(): number {
  return config.storageCredentialsEncKeyVersion
}

export function encryptStorageCredentials(creds: StorageCredentials): {
  ciphertext: string
  keyVersion: number
  accessKeyLast4: string
} {
  const version = storageCredentialsKeyVersion()
  const key = keyForVersion(version)
  if (!key) throw new Error('storage credentials encryption key not configured')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, key, iv)
  const payload = JSON.stringify({
    accessKey: creds.accessKey,
    secretKey: creds.secretKey,
  })
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: `v${version}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`,
    keyVersion: version,
    accessKeyLast4: creds.accessKey.slice(-4),
  }
}

export function parseCiphertextKeyVersion(ciphertext: string): number | null {
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || !parts[0].startsWith('v')) return null
  const n = Number(parts[0].slice(1))
  return Number.isInteger(n) && n > 0 ? n : null
}

export function decryptStorageCredentials(ciphertext: string): StorageCredentials {
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || !parts[0].startsWith('v')) {
    throw new Error('storage credentials ciphertext format invalid')
  }
  const version = Number(parts[0].slice(1))
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('storage credentials ciphertext version invalid')
  }
  const [, ivHex, tagHex, ctHex] = parts
  if (!ivHex || !tagHex || !ctHex) {
    throw new Error('storage credentials ciphertext format invalid')
  }
  const key = keyForVersion(version)
  if (!key) {
    throw new Error(
      `storage credentials key version ${version} not available (current=${storageCredentialsKeyVersion()})`,
    )
  }
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
  const parsed = JSON.parse(plain) as StorageCredentials
  if (!parsed.accessKey || !parsed.secretKey) {
    throw new Error('storage credentials payload invalid')
  }
  return parsed
}
