import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Readable } from 'node:stream'
import { config } from '../../config/index.js'
import {
  DeliveryStorage,
  FileTooLargeError,
  PresignedDownload,
  StreamPutResult,
  TMP_KEY_PREFIX,
  sanitizeFileName,
} from './deliveryTypes.js'

interface StoredBlob {
  buffer: Buffer
  createdAt: Date
}

/**
 * dev/test 的私有交付存储。语义对齐 S3 版：对象私有、下载必须经"签名"——
 * 这里用 HMAC token 模拟 presign（/api/uploads/delivery-signed/:token 路由
 * 校验后放行），让权限/过期/篡改的测试不依赖 MinIO。
 */
export class DeliveryMemoryStorage implements DeliveryStorage {
  private readonly blobs = new Map<string, StoredBlob>()

  async putStream(tmpKey: string, stream: Readable, maxBytes: number): Promise<StreamPutResult> {
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) throw new FileTooLargeError(maxBytes)
      hash.update(buf)
      chunks.push(buf)
    }
    this.blobs.set(tmpKey, { buffer: Buffer.concat(chunks), createdAt: new Date() })
    return { sha256: hash.digest('hex'), size }
  }

  async promote(tmpKey: string, finalKey: string): Promise<void> {
    const blob = this.blobs.get(tmpKey)
    if (blob && !this.blobs.has(finalKey)) {
      this.blobs.set(finalKey, { buffer: blob.buffer, createdAt: new Date() })
    }
    this.blobs.delete(tmpKey)
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key)
  }

  async presignDownload(key: string, fileName: string, ttlSeconds: number): Promise<PresignedDownload> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    const token = signDeliveryToken(key, sanitizeFileName(fileName), expiresAt)
    // 相对路径：supertest / 前端 axios 都从同源解析。
    return { url: `/api/uploads/delivery-signed/${token}`, expiresAt }
  }

  async listTmpKeysOlderThan(before: Date): Promise<string[]> {
    return [...this.blobs.entries()]
      .filter(([key, blob]) => key.startsWith(TMP_KEY_PREFIX) && blob.createdAt < before)
      .map(([key]) => key)
  }

  /** 签名透传路由用：token 校验通过后取出字节。 */
  getBlob(key: string): Buffer | null {
    return this.blobs.get(key)?.buffer ?? null
  }
}

interface DeliveryTokenPayload {
  key: string
  fileName: string
  exp: number
}

function tokenMac(body: string): Buffer {
  return createHmac('sha256', config.jwtSecret).update(`delivery-signed:${body}`).digest()
}

export function signDeliveryToken(key: string, fileName: string, expiresAt: Date): string {
  const body = Buffer.from(
    JSON.stringify({ key, fileName, exp: expiresAt.getTime() } satisfies DeliveryTokenPayload)
  ).toString('base64url')
  return `${body}.${tokenMac(body).toString('base64url')}`
}

/** 篡改/过期都返回 null——路由据此回 403，与真实 S3 签名失败同语义。 */
export function verifyDeliveryToken(token: string): DeliveryTokenPayload | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  let given: Buffer
  try {
    given = Buffer.from(mac, 'base64url')
  } catch {
    return null
  }
  const expected = tokenMac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as DeliveryTokenPayload
    if (typeof payload.key !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
