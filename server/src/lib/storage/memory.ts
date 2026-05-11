import { StorageAdapter, PutOptions, PutResult, hashKey } from './types.js'

// Process-local storage used by tests and dev when no S3-compatible
// endpoint is configured. NOT safe for production: blobs disappear on
// every process restart and aren't shared across instances.
export class MemoryStorageAdapter implements StorageAdapter {
  private blobs = new Map<string, { buffer: Buffer; mimeType: string }>()

  constructor(private readonly publicUrlBase = 'http://localhost:3000') {}

  async put(buffer: Buffer, opts: PutOptions): Promise<PutResult> {
    const key = hashKey(buffer, opts.ext)
    this.blobs.set(key, { buffer, mimeType: opts.mimeType })
    return {
      key,
      url: `${this.publicUrlBase}/uploads/${key}`,
    }
  }

  async get(key: string) {
    return this.blobs.get(key) ?? null
  }
}
