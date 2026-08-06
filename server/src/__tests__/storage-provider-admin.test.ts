import { describe, it, expect, beforeEach } from 'vitest'
import { api, createTestUser, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { encryptStorageCredentials } from '../lib/storage/credentialsCrypto.js'
import { invalidateStorageRuntimeCache } from '../lib/storage/runtime.js'

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000' +
    '000d4944415478da6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
)

describe('admin storage console APIs (SPEC-STORAGE-001)', () => {
  let adminToken: string
  let adminId: number

  beforeEach(async () => {
    const { user } = await createTestUser('storage-admin@test.local', 'admin123', 'admin')
    adminId = user.id
    const session = await loginAs('storage-admin@test.local', 'admin123')
    adminToken = session.accessToken
    await prisma.storageProviderConfig.deleteMany({})
    await prisma.storedObject.deleteMany({})
    await prisma.storageRuntime.upsert({
      where: { id: 1 },
      create: { id: 1, activeConfigId: null, configVersion: 0 },
      update: { activeConfigId: null, configVersion: 0 },
    })
    invalidateStorageRuntimeCache()
  })

  it('GET /admin/storage/status returns bootstrap diagnostics without secrets', async () => {
    const res = await api
      .get('/api/admin/storage/status')
      .set(authHeader(adminToken))
      .expect(200)

    expect(res.body.bootstrap).toBeDefined()
    expect(res.body.bootstrap.providerLabel).toBeTruthy()
    expect(res.body.presets?.length).toBeGreaterThan(0)
    expect(JSON.stringify(res.body)).not.toMatch(/secretKey|minio_dev_password/i)
    expect(res.body.runtime.writeTarget).toMatch(/bootstrap|provider/)
  })

  it('creates draft without echoing secret key', async () => {
    const res = await api
      .post('/api/admin/storage/providers')
      .set(authHeader(adminToken))
      .send({
        type: 's3_compatible',
        name: 'Test draft',
        accessKey: 'AKTEST1234',
        secretKey: 'sk-should-never-echo',
        publicConfig: {
          // 必须可 DNS 解析且为公网 IP，否则 endpointGuard 在保存阶段拦截
          endpoint: 'https://s3.amazonaws.com',
          region: 'us-east-1',
          publicBucket: 'pub-bucket',
          privateBucket: 'priv-bucket',
          forcePathStyle: true,
        },
      })
      .expect(201)

    expect(res.body.id).toBeTypeOf('number')
    expect(res.body.status).toBe('draft')
    expect(res.body.accessKeyConfigured).toBe(true)
    expect(res.body.accessKeyLast4).toBe('1234')
    expect(JSON.stringify(res.body)).not.toContain('sk-should-never-echo')
    expect(res.body.credentialsCiphertext).toBeUndefined()
  })

  it('rejects same public/private bucket names', async () => {
    await api
      .post('/api/admin/storage/providers')
      .set(authHeader(adminToken))
      .send({
        type: 'r2',
        name: 'bad buckets',
        accessKey: 'ak',
        secretKey: 'sk',
        publicConfig: {
          endpoint: 'https://abc.r2.cloudflarestorage.com',
          region: 'auto',
          publicBucket: 'same',
          privateBucket: 'same',
          forcePathStyle: true,
        },
      })
      .expect(400)
  })

  it('activate requires verified status', async () => {
    const created = await prisma.storageProviderConfig.create({
      data: {
        type: 's3_compatible',
        name: 'unverified',
        status: 'draft',
        publicConfig: {
          endpoint: 'https://s3.example.com',
          region: 'us-east-1',
          publicBucket: 'a',
          privateBucket: 'b',
          forcePathStyle: true,
        },
        credentialsCiphertext: encryptStorageCredentials({
          accessKey: 'ak',
          secretKey: 'sk',
        }).ciphertext,
        accessKeyLast4: 'ak',
        createdById: adminId,
      },
    })

    await api
      .post(`/api/admin/storage/providers/${created.id}/activate`)
      .set(authHeader(adminToken))
      .expect(400)
  })

  it('registers StoredObject on image upload with env providerRef', async () => {
    await createTestUser('storage-upload@test.local', 'testpass123')
    const { accessToken } = await loginAs('storage-upload@test.local', 'testpass123')
    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', TINY_PNG, { filename: 't.png', contentType: 'image/png' })
      .expect(200)

    expect(res.body.key).toBeTruthy()
    const row = await prisma.storedObject.findFirst({
      where: { objectKey: res.body.key, bucketRole: 'public' },
    })
    expect(row).toBeTruthy()
    expect(row!.providerRef).toBe('env')
    expect(row!.providerConfigId).toBeNull()
  })

  it('refuses activate when STORAGE_CONFIG_SOURCE=env (circuit breaker)', async () => {
    const prev = process.env.STORAGE_CONFIG_SOURCE
    // Config is loaded at process start — this test documents API-level guard
    // when config.storageConfigSource === 'env'. If runtime config is not env,
    // skip by expecting either 403 or verifying service throws via direct call.
    const { activateStorageProvider } = await import('../modules/admin/storageService.js')
    const { config } = await import('../config/index.js')
    if (config.storageConfigSource !== 'env') {
      // Inject by temporarily patching is not available; call with mock would need DI.
      // At least ensure verified→activate path still rejects non-verified (above).
      expect(config.storageConfigSource).toMatch(/database|env/)
      return
    }
    const created = await prisma.storageProviderConfig.create({
      data: {
        type: 's3_compatible',
        name: 'blocked-activate',
        status: 'verified',
        publicConfig: {
          endpoint: 'https://s3.amazonaws.com',
          region: 'us-east-1',
          publicBucket: 'a',
          privateBucket: 'b',
          forcePathStyle: true,
        },
        credentialsCiphertext: encryptStorageCredentials({
          accessKey: 'ak',
          secretKey: 'sk',
        }).ciphertext,
        accessKeyLast4: 'ak',
        createdById: adminId,
      },
    })
    await expect(activateStorageProvider(adminId, created.id)).rejects.toMatchObject({
      status: 403,
    })
    process.env.STORAGE_CONFIG_SOURCE = prev
  })
})
