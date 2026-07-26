import type { Readable } from 'node:stream'

/**
 * P5 受控文件交付的存储契约。与公开图片的 StorageAdapter 刻意分离：
 * 这里的一切都以"桶是私有的、下载必须经短时签名"为前提。
 */

export interface StreamPutResult {
  /** 全量 SHA-256（hex，64 字符）。 */
  sha256: string
  size: number
}

export class FileTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`file exceeds ${maxBytes} bytes`)
    this.name = 'FileTooLargeError'
  }
}

export interface PresignedDownload {
  url: string
  expiresAt: Date
}

export interface DeliveryStorage {
  /**
   * 流式写入临时对象键（恒定内存），边写边算 SHA-256 与字节数。
   * 超过 maxBytes 时中止上传、清掉已写入的临时对象并抛 FileTooLargeError。
   */
  putStream(tmpKey: string, stream: Readable, maxBytes: number): Promise<StreamPutResult>
  /**
   * 把临时对象晋升为最终键（server-side copy + 删临时对象）。
   * 最终键已存在（内容寻址去重命中）时只删临时对象。
   */
  promote(tmpKey: string, finalKey: string): Promise<void>
  /** 尽力删除；对象不存在不报错（GC 幂等重试依赖这一点）。 */
  delete(key: string): Promise<void>
  /**
   * 签发短时下载 URL。强制 attachment + application/octet-stream——
   * MIME 不受信任，绝不允许浏览器内联渲染付费文件。
   */
  presignDownload(key: string, fileName: string, ttlSeconds: number): Promise<PresignedDownload>
  /** tmp/ 前缀里早于 before 的遗留对象（上传失败未清干净时由 GC 兜底）。 */
  listTmpKeysOlderThan(before: Date): Promise<string[]>
  // ---- 备份/恢复用（portable-backups；不进任何请求路径）----
  /** 列出全部对象（含 tmp/，调用方自行过滤）。 */
  list(): Promise<Array<{ key: string; size: number }>>
  /** 读对象字节；不存在返回 null。 */
  getObject(key: string): Promise<Buffer | null>
  /** 按指定键写入（恢复用）。 */
  putObjectAt(key: string, buffer: Buffer): Promise<void>
}

export const TMP_KEY_PREFIX = 'tmp/'

/**
 * 下载文件名净化：去路径分隔、控制字符与引号类字符，长度 ≤200。
 * 展示名进 Content-Disposition，脏名会破坏头部或诱导路径穿越观感。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/\x00-\x1f\x7f"';]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return cleaned || 'download'
}
