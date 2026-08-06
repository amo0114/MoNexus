import api from './client'

export interface StoragePreset {
  type: 'r2' | 'oss' | 'cos' | 's3_compatible'
  label: string
  forcePathStyleDefault: boolean
  endpointHint: string
  notes: string
}

export interface StorageStatus {
  uiConfigEnabled: boolean
  configSource: 'env' | 'database'
  credentialsEncKeyConfigured: boolean
  bootstrap: {
    kind: 's3' | 'memory'
    providerLabel: string
    endpointHost: string | null
    region: string | null
    publicBucket: string | null
    privateBucket: string | null
    publicUrlBaseConfigured: boolean
    forcePathStyle: boolean
    healthy: boolean
    healthDetail: string
  }
  runtime: {
    activeConfigId: number | null
    configVersion: number
    writeTarget: 'bootstrap' | 'provider'
    activeCredentialsDecryptOk: boolean | null
  }
  presets: StoragePreset[]
}

export interface StorageProviderPublicConfig {
  endpoint: string
  region: string
  publicBucket: string
  privateBucket: string
  publicUrlBase?: string
  deliveryPublicEndpoint?: string
  forcePathStyle: boolean
}

export interface StorageProviderItem {
  id: number
  type: string
  name: string
  status: string
  configVersion: number
  publicConfig: StorageProviderPublicConfig
  accessKeyConfigured: boolean
  accessKeyLast4: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestSummary: string | null
  verifiedAt: string | null
  activatedAt: string | null
  disabledAt: string | null
  previousActiveId: number | null
  createdAt: string
  updatedAt: string
}

export async function getAdminStorageStatus(): Promise<StorageStatus> {
  const { data } = await api.get<StorageStatus>('/admin/storage/status')
  return data
}

export async function listAdminStorageProviders(): Promise<StorageProviderItem[]> {
  const { data } = await api.get<{ items: StorageProviderItem[] }>('/admin/storage/providers')
  return data.items
}

export async function createAdminStorageProvider(body: {
  type: string
  name: string
  publicConfig: StorageProviderPublicConfig
  accessKey: string
  secretKey: string
}): Promise<StorageProviderItem> {
  const { data } = await api.post<StorageProviderItem>('/admin/storage/providers', body)
  return data
}

export async function updateAdminStorageProvider(
  id: number,
  body: Partial<{
    type: string
    name: string
    publicConfig: StorageProviderPublicConfig
    accessKey: string
    secretKey: string
  }>,
): Promise<StorageProviderItem> {
  const { data } = await api.patch<StorageProviderItem>(`/admin/storage/providers/${id}`, body)
  return data
}

export async function testAdminStorageProvider(id: number): Promise<{
  provider: StorageProviderItem
  probe: { ok: boolean; summary: string; checks: Array<{ name: string; ok: boolean; detail?: string }> }
}> {
  const { data } = await api.post(`/admin/storage/providers/${id}/test`)
  return data
}

export async function activateAdminStorageProvider(id: number): Promise<StorageProviderItem> {
  const { data } = await api.post<StorageProviderItem>(`/admin/storage/providers/${id}/activate`)
  return data
}

export async function rollbackAdminStorageProvider(id: number): Promise<StorageProviderItem> {
  const { data } = await api.post<StorageProviderItem>(`/admin/storage/providers/${id}/rollback`)
  return data
}

export async function disableAdminStorageProvider(id: number): Promise<StorageProviderItem> {
  const { data } = await api.post<StorageProviderItem>(`/admin/storage/providers/${id}/disable`)
  return data
}
