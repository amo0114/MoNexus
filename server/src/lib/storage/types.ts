import crypto from 'crypto'

export interface PutOptions {
  mimeType: string
  ext: string
}

export interface PutResult {
  key: string
  url: string
}

export interface StorageAdapter {
  put(buffer: Buffer, opts: PutOptions): Promise<PutResult>
  get(key: string): Promise<{ buffer: Buffer; mimeType: string } | null>
}

export function hashKey(buffer: Buffer, ext: string): string {
  // Content-addressed: same buffer → same key. Cheap dedupe and the URL
  // is cacheable forever because it never changes once a blob is stored.
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  return `${hash}.${ext}`
}
