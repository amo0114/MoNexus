import { afterEach, describe, expect, it, vi } from 'vitest'

const aws = vi.hoisted(() => ({
  clientCtor: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(input: unknown) {
      aws.clientCtor(input)
    }

    send(command: unknown) {
      return aws.send(command)
    }
  }

  class PutObjectCommand {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
    }
  }

  class GetObjectCommand {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
    }
  }

  return { S3Client, PutObjectCommand, GetObjectCommand }
})

const storageEnvKeys = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'STORAGE_PUBLIC_URL_BASE',
  'STORAGE_FORCE_PATH_STYLE',
] as const

function clearStorageEnv() {
  for (const key of storageEnvKeys) {
    vi.stubEnv(key, undefined)
  }
}

function stubS3Env() {
  clearStorageEnv()
  vi.stubEnv('STORAGE_ENDPOINT', 'https://s3.example.test')
  vi.stubEnv('STORAGE_BUCKET', 'test-bucket')
  vi.stubEnv('STORAGE_ACCESS_KEY', 'test-access-key')
  vi.stubEnv('STORAGE_SECRET_KEY', 'test-secret-key')
  vi.stubEnv('STORAGE_PUBLIC_URL_BASE', 'https://cdn.example.test')
}

async function loadStorage() {
  vi.resetModules()
  const storageModule = await import('../lib/storage/index.js')
  storageModule.__setStorageForTesting(null)
  return storageModule
}

describe('storage adapter factory', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('uses the in-memory adapter when S3 storage env is not configured', async () => {
    clearStorageEnv()
    const { getStorage } = await loadStorage()

    const storage = await getStorage()
    const buffer = Buffer.from('memory-backed object')
    const put = await storage.put(buffer, { mimeType: 'text/plain', ext: 'txt' })

    expect(put.key).toMatch(/^[a-f0-9]{32}\.txt$/)
    expect(put.url).toBe(`http://localhost:3000/uploads/${put.key}`)
    await expect(storage.get(put.key)).resolves.toEqual({
      buffer,
      mimeType: 'text/plain',
    })
    expect(aws.clientCtor).not.toHaveBeenCalled()
  })

  it('uses S3 when all required storage env vars are configured', async () => {
    stubS3Env()
    aws.send.mockResolvedValueOnce({})
    const { getStorage } = await loadStorage()

    const storage = await getStorage()
    const buffer = Buffer.from('s3-backed object')
    const put = await storage.put(buffer, { mimeType: 'image/png', ext: 'png' })

    expect(aws.clientCtor).toHaveBeenCalledWith({
      endpoint: 'https://s3.example.test',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
      forcePathStyle: true,
    })
    expect(put.key).toMatch(/^[a-f0-9]{32}\.png$/)
    expect(put.url).toBe(`https://cdn.example.test/${put.key}`)
    expect(aws.send).toHaveBeenCalledTimes(1)
    expect(aws.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: 'test-bucket',
        Key: put.key,
        Body: buffer,
        ContentType: 'image/png',
      },
    })
  })

  it('converts an S3 GetObjectCommand body to a Buffer', async () => {
    stubS3Env()
    aws.send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => Uint8Array.from([1, 2, 3, 4]),
      },
      ContentType: 'image/webp',
    })
    const { getStorage } = await loadStorage()

    const storage = await getStorage()
    const blob = await storage.get('object.webp')

    expect(aws.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: 'test-bucket', Key: 'object.webp' },
      })
    )
    expect(blob).toEqual({
      buffer: Buffer.from([1, 2, 3, 4]),
      mimeType: 'image/webp',
    })
  })

  it('returns null when S3 reports a missing key', async () => {
    stubS3Env()
    aws.send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
    const { getStorage } = await loadStorage()

    const storage = await getStorage()

    await expect(storage.get('missing.png')).resolves.toBeNull()
  })
})
