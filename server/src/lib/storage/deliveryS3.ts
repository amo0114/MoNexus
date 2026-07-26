import { createHash } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  DeliveryStorage,
  FileTooLargeError,
  PresignedDownload,
  StreamPutResult,
  TMP_KEY_PREFIX,
  sanitizeFileName,
} from './deliveryTypes.js'

export interface DeliveryS3Config {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  publicEndpoint: string
  forcePathStyle: boolean
}

/**
 * P5 私有交付桶适配器。双 client 是设计核心：
 * - ops client 用内网 endpoint（compose 里的 http://minio:9000）做上传/复制/删除；
 * - presign client 用浏览器可达的公网 endpoint 专职签名——SigV4 把 Host 算进
 *   签名，签名时的 endpoint 必须与浏览器实际请求的一致，内网地址签出的 URL
 *   在用户设备上根本连不上。
 * 桶策略必须保持私有（初始化只建桶，绝不 anonymous set download）。
 */
export class DeliveryS3Storage implements DeliveryStorage {
  private readonly ops: S3Client
  private readonly presigner: S3Client

  constructor(private readonly cfg: DeliveryS3Config) {
    const credentials = { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey }
    this.ops = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials,
      forcePathStyle: cfg.forcePathStyle,
    })
    this.presigner = new S3Client({
      endpoint: cfg.publicEndpoint,
      region: cfg.region,
      credentials,
      forcePathStyle: cfg.forcePathStyle,
    })
  }

  async putStream(tmpKey: string, stream: Readable, maxBytes: number): Promise<StreamPutResult> {
    const hash = createHash('sha256')
    let size = 0
    let tooLarge = false

    // 哈希/计数/限长在同一个 Transform 里完成；超限即销毁流，Upload 会随之中止。
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (size > maxBytes) {
          tooLarge = true
          cb(new FileTooLargeError(maxBytes))
          return
        }
        hash.update(chunk)
        cb(null, chunk)
      },
    })

    const upload = new Upload({
      client: this.ops,
      params: {
        Bucket: this.cfg.bucket,
        Key: tmpKey,
        Body: stream.pipe(meter),
        ContentType: 'application/octet-stream',
      },
      // 8MB 分段、串行——上传大文件时保持恒定内存占用。
      partSize: 8 * 1024 * 1024,
      queueSize: 1,
      leavePartsOnError: false,
    })

    try {
      await upload.done()
    } catch (err) {
      // 中止/失败后尽力清掉可能已成形的临时对象；删不掉的由 tmp/ GC 兜底。
      await this.delete(tmpKey).catch(() => {})
      if (tooLarge || err instanceof FileTooLargeError) throw new FileTooLargeError(maxBytes)
      throw err
    }
    return { sha256: hash.digest('hex'), size }
  }

  async promote(tmpKey: string, finalKey: string): Promise<void> {
    const exists = await this.exists(finalKey)
    if (!exists) {
      await this.ops.send(new CopyObjectCommand({
        Bucket: this.cfg.bucket,
        // CopySource 需要 bucket/key 且 key 要 URL 编码。
        CopySource: `${this.cfg.bucket}/${encodeURIComponent(tmpKey)}`,
        Key: finalKey,
        ContentType: 'application/octet-stream',
        MetadataDirective: 'REPLACE',
      }))
    }
    await this.delete(tmpKey)
  }

  async delete(key: string): Promise<void> {
    // DeleteObject 对不存在的键本就静默成功——GC 幂等重试依赖这一点。
    await this.ops.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
  }

  async presignDownload(key: string, fileName: string, ttlSeconds: number): Promise<PresignedDownload> {
    const safeName = sanitizeFileName(fileName)
    const url = await getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        // 强制下载 + MIME 不受信任：付费文件绝不允许内联渲染（HTML/SVG 型
        // 文件在站点域上内联 = 存储型 XSS）。
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        ResponseContentType: 'application/octet-stream',
        // 文件响应本身也 no-store：付费内容不允许进浏览器/中间层缓存
        //（发放端点的 JSON 响应另有各自的 no-store）。
        ResponseCacheControl: 'no-store, private',
      }),
      { expiresIn: ttlSeconds }
    )
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) }
  }

  async listTmpKeysOlderThan(before: Date): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const res = await this.ops.send(new ListObjectsV2Command({
        Bucket: this.cfg.bucket,
        Prefix: TMP_KEY_PREFIX,
        ContinuationToken: continuationToken,
      }))
      for (const obj of res.Contents ?? []) {
        if (obj.Key && obj.LastModified && obj.LastModified < before) keys.push(obj.Key)
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (continuationToken)
    return keys
  }

  async listFinalKeysOlderThan(before: Date): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const res = await this.ops.send(new ListObjectsV2Command({
        Bucket: this.cfg.bucket,
        ContinuationToken: continuationToken,
      }))
      for (const obj of res.Contents ?? []) {
        if (obj.Key && !obj.Key.startsWith(TMP_KEY_PREFIX) && obj.LastModified && obj.LastModified < before) {
          keys.push(obj.Key)
        }
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (continuationToken)
    return keys
  }

  async list(): Promise<Array<{ key: string; size: number }>> {
    const objects: Array<{ key: string; size: number }> = []
    let continuationToken: string | undefined
    do {
      const res = await this.ops.send(new ListObjectsV2Command({
        Bucket: this.cfg.bucket,
        ContinuationToken: continuationToken,
      }))
      for (const obj of res.Contents ?? []) {
        if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0 })
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (continuationToken)
    return objects
  }

  async getObject(key: string): Promise<Buffer | null> {
    try {
      const res = await this.ops.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      if (!res.Body) return null
      return Buffer.from(await res.Body.transformToByteArray())
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  async putObjectAt(key: string, buffer: Buffer): Promise<void> {
    await this.ops.send(new PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'application/octet-stream',
    }))
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.ops.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return true
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false
      throw err
    }
  }
}
