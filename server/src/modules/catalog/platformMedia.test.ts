// platformMedia.test.ts — centralized media resolver tests
// (SPEC-CMI-UX-001 §5; AC-UX-009~017; T-UX-002). DB-backed (disposable CMI
// database via dbguard) — every case creates its own StoredObject fixtures and
// cleans them up.

import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  MediaRefResolutionError,
  resolveLegacyPlatformImageUrl,
  resolvePlatformPublicImage,
} from './platformMedia.js'

let serial = 0
const createdObjectKeys: string[] = []
const createdProviderIds: number[] = []

function uniq(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now()}-${serial}`
}

async function registerObject(input: {
  objectKey: string
  bucketRole?: 'public' | 'private'
  status?: string
  source?: string
  providerConfigId?: number | null
}) {
  const providerRef = input.providerConfigId == null ? 'env' : String(input.providerConfigId)
  await prisma.storedObject.create({
    data: {
      providerConfigId: input.providerConfigId ?? null,
      providerRef,
      bucketRole: input.bucketRole ?? 'public',
      objectKey: input.objectKey,
      status: input.status ?? 'active',
      source: input.source ?? 'upload_image',
    },
  })
  createdObjectKeys.push(input.objectKey)
}

async function createProvider(publicUrlBase: string) {
  const provider = await prisma.storageProviderConfig.create({
    data: {
      type: 's3_compatible',
      name: uniq('cdn-provider'),
      status: 'active',
      configVersion: 1,
      publicConfig: {
        endpoint: 'https://minio.internal:9000',
        region: 'us-east-1',
        publicBucket: 'public-assets',
        privateBucket: 'private-assets',
        publicUrlBase,
        forcePathStyle: true,
      },
      credentialsCiphertext: 'test-enc',
      accessKeyLast4: 'abcd',
    },
  })
  createdProviderIds.push(provider.id)
  return provider
}

afterEach(async () => {
  await prisma.storedObject.deleteMany({ where: { objectKey: { in: createdObjectKeys } } })
  createdObjectKeys.length = 0
  await prisma.storageProviderConfig.deleteMany({ where: { id: { in: createdProviderIds } } })
  createdProviderIds.length = 0
})

describe('resolvePlatformPublicImage — upload objects', () => {
  it('resolves an active public upload_image object to a canonical URL (AC-UX-009)', async () => {
    const key = `${uniq('cover')}.webp`
    await registerObject({ objectKey: key })
    const resolved = await resolvePlatformPublicImage({ kind: 'upload', objectKey: key })
    expect(resolved.canonicalUrl).toBe(`http://localhost:3000/uploads/${key}`)
    expect(resolved.objectKey).toBe(key)
    expect(resolved.source).toBe('upload_image')
  })

  it('resolves a provider-bound object via its own provider publicUrlBase (AC-UX-011)', async () => {
    const provider = await createProvider('https://cdn.example.com')
    const key = `${uniq('cdn-cover')}.png`
    await registerObject({ objectKey: key, providerConfigId: provider.id })
    const resolved = await resolvePlatformPublicImage({ kind: 'upload', objectKey: key })
    expect(resolved.canonicalUrl).toBe(`https://cdn.example.com/${key}`)
  })

  it('rejects missing objects fail-closed (AC-UX-013)', async () => {
    await expect(
      resolvePlatformPublicImage({ kind: 'upload', objectKey: `${uniq('missing')}.png` }),
    ).rejects.toMatchObject({ reason: 'object_missing' })
  })

  it('rejects inactive / wrong-source / private objects (AC-UX-013)', async () => {
    const inactive = `${uniq('inactive')}.png`
    await registerObject({ objectKey: inactive, status: 'deleted' })
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: inactive }))
      .rejects.toMatchObject({ reason: 'object_missing' })

    const wrongSource = `${uniq('wrong')}.png`
    await registerObject({ objectKey: wrongSource, source: 'delivery_file' })
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: wrongSource }))
      .rejects.toMatchObject({ reason: 'object_missing' })

    const privateObject = `${uniq('private')}.png`
    await registerObject({ objectKey: privateObject, bucketRole: 'private' })
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: privateObject }))
      .rejects.toMatchObject({ reason: 'object_missing' })
  })

  it('rejects traversal / control / query object keys (AC-UX-013)', async () => {
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: '../etc/passwd' }))
      .rejects.toMatchObject({ reason: 'invalid_key' })
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: 'a%2fb.png' }))
      .rejects.toMatchObject({ reason: 'invalid_key' })
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: 'a?x=1' }))
      .rejects.toMatchObject({ reason: 'invalid_key' })
    await expect(resolvePlatformPublicImage({ kind: 'upload', objectKey: 'a#frag.png' }))
      .rejects.toMatchObject({ reason: 'invalid_key' })
  })

  it('accepts static /assets/ allowlist paths', async () => {
    const resolved = await resolvePlatformPublicImage({ kind: 'static', path: '/assets/category/network.webp' })
    expect(resolved.canonicalUrl).toBe('/assets/category/network.webp')
    expect(resolved.source).toBe('static_asset')
  })

  it('rejects non-asset static paths', async () => {
    await expect(resolvePlatformPublicImage({ kind: 'static', path: 'https://evil.example/x.png' }))
      .rejects.toMatchObject({ reason: 'invalid_static' })
    await expect(resolvePlatformPublicImage({ kind: 'static', path: '/uploads/abc.webp' }))
      .rejects.toMatchObject({ reason: 'invalid_static' })
  })
})

describe('resolveLegacyPlatformImageUrl — legacy string entry', () => {
  it('/uploads/<key> extracts the key and validates the registered object', async () => {
    const key = `${uniq('legacy')}.webp`
    await registerObject({ objectKey: key })
    const resolved = await resolveLegacyPlatformImageUrl(`/uploads/${key}`)
    expect(resolved.canonicalUrl).toBe(`http://localhost:3000/uploads/${key}`)
    expect(resolved.source).toBe('upload_image')
  })

  it('accepts a matching absolute production-style CDN URL (AC-UX-011)', async () => {
    const provider = await createProvider('https://cdn.example.com')
    const key = `${uniq('cdn-legacy')}.png`
    await registerObject({ objectKey: key, providerConfigId: provider.id })
    const resolved = await resolveLegacyPlatformImageUrl(`https://cdn.example.com/${key}`)
    expect(resolved.canonicalUrl).toBe(`https://cdn.example.com/${key}`)
  })

  it('rejects absolute URLs that do not map to the object provider (AC-UX-011)', async () => {
    const provider = await createProvider('https://cdn.example.com')
    const key = `${uniq('cdn-mismatch')}.png`
    await registerObject({ objectKey: key, providerConfigId: provider.id })
    await expect(resolveLegacyPlatformImageUrl(`https://cdn.evil.example/${key}`))
      .rejects.toMatchObject({ reason: 'provider_mismatch' })
  })

  it('rejects arbitrary external URLs (never trusts a client URL)', async () => {
    await expect(resolveLegacyPlatformImageUrl('https://external.example/foo.png'))
      .rejects.toBeInstanceOf(MediaRefResolutionError)
    await expect(resolveLegacyPlatformImageUrl('http://localhost:9999/private/secrets.png'))
      .rejects.toBeInstanceOf(MediaRefResolutionError)
  })

  it('rejects empty / non-platform values', async () => {
    await expect(resolveLegacyPlatformImageUrl('')).rejects.toBeInstanceOf(MediaRefResolutionError)
    await expect(resolveLegacyPlatformImageUrl('not-a-path')).rejects.toBeInstanceOf(MediaRefResolutionError)
    await expect(resolveLegacyPlatformImageUrl('/other/thing.png')).rejects.toBeInstanceOf(MediaRefResolutionError)
  })

  it('/assets/ legacy strings resolve through the static allowlist', async () => {
    const resolved = await resolveLegacyPlatformImageUrl('/assets/category/default.webp')
    expect(resolved.canonicalUrl).toBe('/assets/category/default.webp')
    expect(resolved.source).toBe('static_asset')
  })
})
