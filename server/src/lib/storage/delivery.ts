import type { DeliveryStorage } from './deliveryTypes.js'
import {
  getWriteDeliveryStorage,
  getReadDeliveryStorage,
  __resetStorageRuntimeForTesting,
  __setDeliveryStorageForTesting as setDeliveryOverride,
} from './runtime.js'

/**
 * P5 私有交付存储工厂（写路径）。
 * SPEC-STORAGE-001：与公开桶共用 active 提供商配置中的 privateBucket。
 */
export async function getDeliveryStorage(): Promise<DeliveryStorage> {
  const { adapter } = await getWriteDeliveryStorage()
  return adapter
}

export async function getDeliveryStorageForWrite(): Promise<{
  adapter: DeliveryStorage
  providerConfigId: number | null
}> {
  return getWriteDeliveryStorage()
}

export async function getDeliveryStorageForProvider(
  providerConfigId: number | null | undefined,
): Promise<DeliveryStorage> {
  return getReadDeliveryStorage(providerConfigId)
}

export function __setDeliveryStorageForTesting(adapter: DeliveryStorage | null) {
  if (adapter == null) {
    __resetStorageRuntimeForTesting()
    return
  }
  setDeliveryOverride(adapter)
}

export type { DeliveryStorage } from './deliveryTypes.js'
