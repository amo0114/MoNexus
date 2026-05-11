import { config } from '../../config/index.js'
import { MemoryStorageAdapter } from './memory.js'
import type { StorageAdapter } from './types.js'

let cached: StorageAdapter | null = null

// Lazy factory so the S3 SDK module is only imported when actually
// needed. Memory adapter has zero external deps and is always safe.
export async function getStorage(): Promise<StorageAdapter> {
  if (cached) return cached

  let adapter: StorageAdapter
  if (config.storage.kind === 'memory') {
    adapter = new MemoryStorageAdapter()
  } else {
    // Dynamic import keeps @aws-sdk out of test boot time.
    const { S3StorageAdapter } = await import('./s3.js')
    adapter = new S3StorageAdapter(config.storage)
  }
  cached = adapter
  return adapter
}

// Test-only escape hatch: replace the cached adapter so a test can pin
// behavior without depending on env var ordering.
export function __setStorageForTesting(adapter: StorageAdapter | null) {
  cached = adapter
}

export type { StorageAdapter } from './types.js'
