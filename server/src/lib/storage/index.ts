import type { StorageAdapter } from './types.js'
import {
  getWritePublicStorage,
  getReadPublicStorage,
  __resetStorageRuntimeForTesting,
  __setPublicStorageForTesting,
} from './runtime.js'
import { findStoredObject } from './storedObjectRegistry.js'

/**
 * 公开图片存储工厂（写路径）。
 * SPEC-STORAGE-001：优先 active DB 提供商，否则 env/MinIO 底座。
 */
export async function getStorage(): Promise<StorageAdapter> {
  const { adapter } = await getWritePublicStorage()
  return adapter
}

/** 写路径 + 绑定 id（上传登记 StoredObject 用）。 */
export async function getStorageForWrite(): Promise<{
  adapter: StorageAdapter
  providerConfigId: number | null
}> {
  return getWritePublicStorage()
}

/** 按对象 key 解析读适配器（有登记则按绑定 provider）。 */
export async function getStorageForObjectKey(objectKey: string): Promise<StorageAdapter> {
  const row = await findStoredObject('public', objectKey)
  return getReadPublicStorage(row?.providerConfigId ?? null)
}

export function __setStorageForTesting(adapter: StorageAdapter | null) {
  if (adapter == null) {
    __resetStorageRuntimeForTesting()
    return
  }
  __setPublicStorageForTesting(adapter)
}

export type { StorageAdapter } from './types.js'
