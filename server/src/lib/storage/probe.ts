import { randomUUID } from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ProviderPublicConfig } from './providerPresets.js'
import type { StorageCredentials } from './credentialsCrypto.js'

export interface ProbeInput {
  publicConfig: ProviderPublicConfig
  credentials: StorageCredentials
}

export interface ProbeResult {
  ok: boolean
  summary: string
  checks: Array<{ name: string; ok: boolean; detail?: string }>
}

function clientFor(cfg: ProviderPublicConfig, creds: StorageCredentials) {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region || 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
    },
    forcePathStyle: cfg.forcePathStyle,
  })
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> }
  if (typeof maybe.transformToByteArray === 'function') {
    return Buffer.from(await maybe.transformToByteArray())
  }
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function probeBucket(
  client: S3Client,
  bucket: string,
  role: 'public' | 'private',
  opts: {
    publicUrlBase?: string
    deliveryPublicEndpoint?: string
    forcePathStyle: boolean
    endpoint: string
  },
): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const key = `__monexus_probe__/${randomUUID()}.txt`
  const payload = Buffer.from(`monexus-probe-${role}-${Date.now()}`, 'utf8')

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentType: 'text/plain',
      }),
    )
    checks.push({ name: `${role}:put`, ok: true })
  } catch (err) {
    checks.push({
      name: `${role}:put`,
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 160) : 'put failed',
    })
    return checks
  }

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    checks.push({ name: `${role}:head`, ok: true })
  } catch (err) {
    checks.push({
      name: `${role}:head`,
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 160) : 'head failed',
    })
  }

  try {
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const buf = got.Body ? await bodyToBuffer(got.Body) : Buffer.alloc(0)
    checks.push({
      name: `${role}:get`,
      ok: buf.equals(payload),
      detail: buf.equals(payload) ? undefined : 'content mismatch',
    })
  } catch (err) {
    checks.push({
      name: `${role}:get`,
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 160) : 'get failed',
    })
  }

  if (role === 'private') {
    try {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 60 },
      )
      const res = await fetch(url, { method: 'GET', redirect: 'error' })
      const text = await res.text()
      checks.push({
        name: 'private:presign',
        ok: res.ok && text.includes('monexus-probe'),
        detail: res.ok ? undefined : `http ${res.status}`,
      })
    } catch (err) {
      checks.push({
        name: 'private:presign',
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 160) : 'presign failed',
      })
    }

    // Anonymous URL should fail for private objects.
    try {
      const base = opts.deliveryPublicEndpoint?.replace(/\/$/, '')
        ?? opts.endpoint.replace(/\/$/, '')
      const anonUrl = opts.forcePathStyle
        ? `${base}/${bucket}/${key}`
        : `${base}/${key}`
      const res = await fetch(anonUrl, { method: 'GET', redirect: 'error' })
      checks.push({
        name: 'private:anonymous_denied',
        ok: res.status === 403 || res.status === 401 || res.status === 404,
        detail: `http ${res.status}`,
      })
    } catch {
      // Network error to anonymous URL is acceptable (private network).
      checks.push({ name: 'private:anonymous_denied', ok: true, detail: 'unreachable-ok' })
    }
  }

  if (role === 'public' && opts.publicUrlBase) {
    try {
      const url = `${opts.publicUrlBase.replace(/\/$/, '')}/${key}`
      const res = await fetch(url, { method: 'GET', redirect: 'error' })
      checks.push({
        name: 'public:url',
        ok: res.ok,
        detail: res.ok ? undefined : `http ${res.status}`,
      })
    } catch (err) {
      checks.push({
        name: 'public:url',
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 160) : 'public url failed',
      })
    }
  }

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    checks.push({ name: `${role}:delete`, ok: true })
  } catch (err) {
    checks.push({
      name: `${role}:delete`,
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 160) : 'delete failed — probe object may remain',
    })
  }

  return checks
}

export async function probeStorageProvider(input: ProbeInput): Promise<ProbeResult> {
  const { publicConfig: cfg, credentials } = input
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []

  if (cfg.publicBucket === cfg.privateBucket) {
    return {
      ok: false,
      summary: '公有桶与私有桶名称不得相同',
      checks: [{ name: 'buckets_distinct', ok: false }],
    }
  }
  checks.push({ name: 'buckets_distinct', ok: true })

  const client = clientFor(cfg, credentials)
  try {
    const pub = await probeBucket(client, cfg.publicBucket, 'public', {
      publicUrlBase: cfg.publicUrlBase,
      forcePathStyle: cfg.forcePathStyle,
      endpoint: cfg.endpoint,
    })
    checks.push(...pub)

    const priv = await probeBucket(client, cfg.privateBucket, 'private', {
      deliveryPublicEndpoint: cfg.deliveryPublicEndpoint,
      forcePathStyle: cfg.forcePathStyle,
      endpoint: cfg.endpoint,
    })
    checks.push(...priv)
  } finally {
    client.destroy()
  }

  const failed = checks.filter(c => !c.ok)
  const ok = failed.length === 0
  return {
    ok,
    summary: ok
      ? `全部 ${checks.length} 项检查通过`
      : `失败 ${failed.length} 项：${failed.map(f => f.name).join(', ')}`,
    checks,
  }
}
