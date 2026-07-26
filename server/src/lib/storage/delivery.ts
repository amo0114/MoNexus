import { config } from '../../config/index.js'
import { DeliveryMemoryStorage } from './deliveryMemory.js'
import type { DeliveryStorage } from './deliveryTypes.js'

let cached: DeliveryStorage | null = null

/**
 * P5 私有交付存储工厂。与公开图片的 getStorage 平行：S3 SDK 仅在真正
 * 需要时动态加载；未配置 DELIVERY_STORAGE_BUCKET 时回落 memory 实现
 * （仅 dev/test 安全，生产守卫在 config 层）。
 */
export async function getDeliveryStorage(): Promise<DeliveryStorage> {
  if (cached) return cached
  if (config.deliveryStorage.kind === 'memory') {
    cached = new DeliveryMemoryStorage()
  } else {
    const { DeliveryS3Storage } = await import('./deliveryS3.js')
    cached = new DeliveryS3Storage(config.deliveryStorage)
  }
  return cached
}

export function __setDeliveryStorageForTesting(adapter: DeliveryStorage | null) {
  cached = adapter
}

export type { DeliveryStorage } from './deliveryTypes.js'
