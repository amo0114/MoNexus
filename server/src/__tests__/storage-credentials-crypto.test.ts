import { describe, it, expect } from 'vitest'
import {
  encryptStorageCredentials,
  decryptStorageCredentials,
} from '../lib/storage/credentialsCrypto.js'

describe('storage credentials crypto (SPEC-STORAGE-001)', () => {
  it('round-trips accessKey/secretKey', () => {
    const enc = encryptStorageCredentials({
      accessKey: 'AKIAEXAMPLE',
      secretKey: 'super-secret-value',
    })
    expect(enc.ciphertext.startsWith('v')).toBe(true)
    expect(enc.accessKeyLast4).toBe('MPLE')
    const plain = decryptStorageCredentials(enc.ciphertext)
    expect(plain.accessKey).toBe('AKIAEXAMPLE')
    expect(plain.secretKey).toBe('super-secret-value')
  })

  it('rejects tampered ciphertext', () => {
    const enc = encryptStorageCredentials({
      accessKey: 'key',
      secretKey: 'sec',
    })
    const parts = enc.ciphertext.split(':')
    parts[3] = parts[3].replace(/0/g, '1').replace(/1/g, '0')
    expect(() => decryptStorageCredentials(parts.join(':'))).toThrow()
  })

  it('rejects malformed payload', () => {
    expect(() => decryptStorageCredentials('not-valid')).toThrow()
  })
})
