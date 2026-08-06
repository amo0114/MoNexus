export const STORAGE_PROVIDER_TYPES = ['r2', 'oss', 'cos', 's3_compatible'] as const
export type StorageProviderType = (typeof STORAGE_PROVIDER_TYPES)[number]

export const STORAGE_PROVIDER_STATUSES = ['draft', 'verified', 'active', 'disabled'] as const
export type StorageProviderStatus = (typeof STORAGE_PROVIDER_STATUSES)[number]

export interface ProviderPublicConfig {
  endpoint: string
  region: string
  publicBucket: string
  privateBucket: string
  publicUrlBase?: string
  deliveryPublicEndpoint?: string
  forcePathStyle: boolean
}

export interface ProviderPresetMeta {
  type: StorageProviderType
  label: string
  forcePathStyleDefault: boolean
  endpointHint: string
  notes: string
}

export const PROVIDER_PRESETS: ProviderPresetMeta[] = [
  {
    type: 'r2',
    label: 'Cloudflare R2',
    forcePathStyleDefault: true,
    endpointHint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    notes: '使用 S3 兼容 API；公有访问建议绑自定义域名到 publicUrlBase。',
  },
  {
    type: 'oss',
    label: '阿里云 OSS',
    forcePathStyleDefault: false,
    endpointHint: 'https://oss-<region>.aliyuncs.com',
    notes: '请开启 S3 兼容访问或使用对应外网 Endpoint；公私桶须分离。',
  },
  {
    type: 'cos',
    label: '腾讯云 COS',
    forcePathStyleDefault: false,
    endpointHint: 'https://cos.<region>.myqcloud.com',
    notes: 'S3 兼容 Endpoint；Region 与控制台一致。',
  },
  {
    type: 's3_compatible',
    label: '自定义 S3 兼容',
    forcePathStyleDefault: true,
    endpointHint: 'https://s3.example.com',
    notes: '任意 SigV4 S3 兼容实现（含外置 MinIO）。',
  },
]

export function presetFor(type: StorageProviderType): ProviderPresetMeta {
  const found = PROVIDER_PRESETS.find(p => p.type === type)
  if (!found) throw new Error(`unknown provider type: ${type}`)
  return found
}
