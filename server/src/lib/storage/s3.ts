import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'stream'
import { StorageAdapter, PutOptions, PutResult, hashKey } from './types.js'

export interface S3StorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  publicUrlBase?: string
  forcePathStyle: boolean
}

// S3-compatible object storage adapter. Tested against MinIO locally;
// the same code targets AWS S3, Cloudflare R2, and Alibaba OSS by
// changing endpoint + publicUrlBase. The bucket is expected to be
// configured with a public-read policy so the returned URL is
// directly fetchable by browsers without signed URLs.
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client

  constructor(private readonly cfg: S3StorageConfig) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secretKey,
      },
      // MinIO and most S3 alternatives require path-style addressing;
      // AWS S3 prefers virtual-host-style. Caller decides via env.
      forcePathStyle: cfg.forcePathStyle,
    })
  }

  async put(buffer: Buffer, opts: PutOptions): Promise<PutResult> {
    const key = hashKey(buffer, opts.ext)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: buffer,
        ContentType: opts.mimeType,
        // Immutable content-addressed key -> cache forever.
        CacheControl: 'public, max-age=31536000, immutable',
      })
    )
    const base = this.cfg.publicUrlBase ?? `${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}`
    return { key, url: `${base}/${key}` }
  }

  async get(key: string) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key })
      )
      if (!res.Body) return null
      const chunks: Buffer[] = []
      for await (const chunk of res.Body as Readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
      }
      return {
        buffer: Buffer.concat(chunks),
        mimeType: res.ContentType ?? 'application/octet-stream',
      }
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
        return null
      }
      throw err
    }
  }
}
