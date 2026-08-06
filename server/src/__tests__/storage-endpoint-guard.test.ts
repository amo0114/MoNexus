import { describe, it, expect } from 'vitest'
import {
  assertSafeStorageEndpoint,
  hostMatchesStorageAllowlist,
} from '../lib/storage/endpointGuard.js'
import { HttpError } from '../lib/httpError.js'

describe('storage endpoint guard (SPEC-STORAGE-001)', () => {
  it('rejects loopback IP literals', async () => {
    await expect(assertSafeStorageEndpoint('http://127.0.0.1:9000')).rejects.toBeInstanceOf(HttpError)
  })

  it('rejects link-local metadata range', async () => {
    await expect(assertSafeStorageEndpoint('http://169.254.169.254/latest')).rejects.toBeInstanceOf(HttpError)
  })

  it('rejects private 10.x', async () => {
    await expect(assertSafeStorageEndpoint('http://10.0.0.5')).rejects.toBeInstanceOf(HttpError)
  })

  it('rejects credentials embedded in URL', async () => {
    await expect(
      assertSafeStorageEndpoint('https://user:pass@example.com'),
    ).rejects.toBeInstanceOf(HttpError)
  })

  it('rejects IPv4-mapped loopback', async () => {
    await expect(assertSafeStorageEndpoint('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(
      HttpError,
    )
  })

  it('allowlist: single-label is exact-only; multi-label allows subdomain; bare TLD rejected', () => {
    const list = ['minio', 'minio.internal', 'com']
    expect(hostMatchesStorageAllowlist('minio', list)).toBe(true)
    expect(hostMatchesStorageAllowlist('evil.minio', list)).toBe(false)
    expect(hostMatchesStorageAllowlist('minio.internal', list)).toBe(true)
    expect(hostMatchesStorageAllowlist('a.minio.internal', list)).toBe(true)
    expect(hostMatchesStorageAllowlist('evil.com', list)).toBe(false)
    expect(hostMatchesStorageAllowlist('com', list)).toBe(false)
  })
})
