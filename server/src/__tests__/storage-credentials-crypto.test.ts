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
    expect(parts).toHaveLength(4)
    expect(parts[3].length).toBeGreaterThan(0)
    const firstNibble = Number.parseInt(parts[3][0], 16)
    expect(Number.isInteger(firstNibble)).toBe(true)
    parts[3] = ((firstNibble ^ 1).toString(16)) + parts[3].slice(1)
    const tampered = parts.join(':')
    expect(tampered).not.toBe(enc.ciphertext)
    expect(() => decryptStorageCredentials(tampered)).toThrow()
  })

  it('rejects malformed payload', () => {
    expect(() => decryptStorageCredentials('not-valid')).toThrow()
  })
})
