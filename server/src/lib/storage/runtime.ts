import { config } from '../../config/index.js'
import { prisma } from '../prisma.js'
import { S3StorageAdapter } from './s3.js'
import { MemoryStorageAdapter } from './memory.js'
import { DeliveryS3Storage } from './deliveryS3.js'
import { DeliveryMemoryStorage } from './deliveryMemory.js'
import type { StorageAdapter } from './types.js'
import type { DeliveryStorage } from './deliveryTypes.js'
import { decryptStorageCredentials } from './credentialsCrypto.js'
import type { ProviderPublicConfig } from './providerPresets.js'
import { logger } from '../logger.js'
import type { Prisma } from '@prisma/client'

const VERSION_TTL_MS = 2000

interface AdapterPair {
  public: StorageAdapter
  private: DeliveryStorage
  configId: number | null
  configVersion: number
}

let bootstrapPair: AdapterPair | null = null
let activePair: AdapterPair | null = null
let cachedRuntimeVersion = -1
let lastVersionCheckAt = 0
let refreshPromise: Promise<void> | null = null
/** 测试注入：覆盖 bootstrap 对，跳过 env/DB。 */
let testOverridePair: AdapterPair | null = null

function buildBootstrapPair(): AdapterPair {
  if (config.storage.kind === 'memory') {
    return {
      public: new MemoryStorageAdapter(),
      private: new DeliveryMemoryStorage(),
      configId: null,
      configVersion: 0,
    }
  }
  const s3 = config.storage
  const pub = new S3StorageAdapter({
    endpoint: s3.endpoint,
    region: s3.region,
    bucket: s3.bucket,
    accessKey: s3.accessKey,
    secretKey: s3.secretKey,
    publicUrlBase: s3.publicUrlBase,
    forcePathStyle: s3.forcePathStyle,
  })
  let priv: DeliveryStorage
  if (config.deliveryStorage.kind === 'memory') {
    priv = new DeliveryMemoryStorage()
  } else {
    const d = config.deliveryStorage
    priv = new DeliveryS3Storage({
      endpoint: d.endpoint,
      region: d.region,
      bucket: d.bucket,
      accessKey: d.accessKey,
      secretKey: d.secretKey,
      publicEndpoint: d.publicEndpoint,
      forcePathStyle: d.forcePathStyle,
    })
  }
  return { public: pub, private: priv, configId: null, configVersion: 0 }
}

function getBootstrap(): AdapterPair {
  if (testOverridePair) return testOverridePair
  if (!bootstrapPair) bootstrapPair = buildBootstrapPair()
  return bootstrapPair
}

function buildPairFromDbConfig(
  configId: number,
  configVersion: number,
  publicConfig: ProviderPublicConfig,
  accessKey: string,
  secretKey: string,
): AdapterPair {
  const pub = new S3StorageAdapter({
    endpoint: publicConfig.endpoint,
    region: publicConfig.region || 'us-east-1',
    bucket: publicConfig.publicBucket,
    accessKey,
    secretKey,
    publicUrlBase: publicConfig.publicUrlBase,
    forcePathStyle: publicConfig.forcePathStyle,
  })
  const priv = new DeliveryS3Storage({
    endpoint: publicConfig.endpoint,
    region: publicConfig.region || 'us-east-1',
    bucket: publicConfig.privateBucket,
    accessKey,
    secretKey,
    publicEndpoint: publicConfig.deliveryPublicEndpoint || publicConfig.endpoint,
    forcePathStyle: publicConfig.forcePathStyle,
  })
  return { public: pub, private: priv, configId, configVersion }
}

async function loadActiveFromDb(): Promise<AdapterPair | null> {
  if (config.storageConfigSource === 'env') return null

  const runtime = await prisma.storageRuntime.findUnique({ where: { id: 1 } })
  if (!runtime?.activeConfigId) return null

  const row = await prisma.storageProviderConfig.findUnique({
    where: { id: runtime.activeConfigId },
  })
  if (!row || row.status !== 'active' || !row.credentialsCiphertext) {
    return null
  }

  try {
    const creds = decryptStorageCredentials(row.credentialsCiphertext)
    const publicConfig = row.publicConfig as unknown as ProviderPublicConfig
    return buildPairFromDbConfig(
      row.id,
      runtime.configVersion,
      publicConfig,
      creds.accessKey,
      creds.secretKey,
    )
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), configId: row.id },
      'storage active config decrypt/build failed; falling back to bootstrap',
    )
    return null
  }
}

async function refreshIfStale(force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - lastVersionCheckAt < VERSION_TTL_MS) return

  if (refreshPromise) {
    await refreshPromise
    return
  }

  refreshPromise = (async () => {
    try {
      if (config.storageConfigSource === 'env') {
        activePair = null
        cachedRuntimeVersion = 0
        lastVersionCheckAt = Date.now()
        return
      }

      const runtime = await prisma.storageRuntime.findUnique({ where: { id: 1 } })
      const version = runtime?.configVersion ?? 0
      lastVersionCheckAt = Date.now()

      if (
        version === cachedRuntimeVersion
        && (
          (runtime?.activeConfigId ?? null) === (activePair?.configId ?? null)
          || (runtime?.activeConfigId == null && activePair == null)
        )
      ) {
        return
      }

      const next = await loadActiveFromDb()
      // Swap pointer only after new pair is ready (no empty window).
      activePair = next
      cachedRuntimeVersion = version
    } finally {
      refreshPromise = null
    }
  })()

  await refreshPromise
}

/** 写路径：active DB 配置优先，否则 env 底座。 */
export async function getWritePublicStorage(): Promise<{
  adapter: StorageAdapter
  providerConfigId: number | null
}> {
  if (testOverridePair) {
    return { adapter: testOverridePair.public, providerConfigId: null }
  }
  await refreshIfStale()
  if (activePair) {
    return { adapter: activePair.public, providerConfigId: activePair.configId }
  }
  const boot = getBootstrap()
  return { adapter: boot.public, providerConfigId: null }
}

export async function getWriteDeliveryStorage(): Promise<{
  adapter: DeliveryStorage
  providerConfigId: number | null
}> {
  if (testOverridePair) {
    return { adapter: testOverridePair.private, providerConfigId: null }
  }
  await refreshIfStale()
  if (activePair) {
    return { adapter: activePair.private, providerConfigId: activePair.configId }
  }
  const boot = getBootstrap()
  return { adapter: boot.private, providerConfigId: null }
}

/**
 * 读路径：按对象绑定的 provider；null/legacy → env 底座。
 * 绑定存在时解密/建客户端失败必须抛错，禁止盲 fallback 到 bootstrap（会读错桶）。
 */
export async function getReadPublicStorage(providerConfigId: number | null | undefined): Promise<StorageAdapter> {
  if (providerConfigId == null) {
    return getBootstrap().public
  }
  await refreshIfStale()
  if (activePair?.configId === providerConfigId) {
    return activePair.public
  }
  const row = await prisma.storageProviderConfig.findUnique({ where: { id: providerConfigId } })
  if (!row?.credentialsCiphertext) {
    logger.error({ providerConfigId }, 'bound storage provider missing credentials')
    throw new Error(`storage provider ${providerConfigId} credentials unavailable`)
  }
  try {
    const creds = decryptStorageCredentials(row.credentialsCiphertext)
    const publicConfig = row.publicConfig as unknown as ProviderPublicConfig
    return buildPairFromDbConfig(
      row.id,
      row.configVersion,
      publicConfig,
      creds.accessKey,
      creds.secretKey,
    ).public
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), providerConfigId },
      'bound storage provider decrypt/build failed',
    )
    throw err
  }
}

export async function getReadDeliveryStorage(providerConfigId: number | null | undefined): Promise<DeliveryStorage> {
  if (providerConfigId == null) {
    return getBootstrap().private
  }
  await refreshIfStale()
  if (activePair?.configId === providerConfigId) {
    return activePair.private
  }
  const row = await prisma.storageProviderConfig.findUnique({ where: { id: providerConfigId } })
  if (!row?.credentialsCiphertext) {
    logger.error({ providerConfigId }, 'bound delivery provider missing credentials')
    throw new Error(`delivery storage provider ${providerConfigId} credentials unavailable`)
  }
  try {
    const creds = decryptStorageCredentials(row.credentialsCiphertext)
    const publicConfig = row.publicConfig as unknown as ProviderPublicConfig
    return buildPairFromDbConfig(
      row.id,
      row.configVersion,
      publicConfig,
      creds.accessKey,
      creds.secretKey,
    ).private
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), providerConfigId },
      'bound delivery provider decrypt/build failed',
    )
    throw err
  }
}

/** 激活成功后由 service 调用，强制各调用方下次刷新。 */
export function invalidateStorageRuntimeCache(): void {
  lastVersionCheckAt = 0
  cachedRuntimeVersion = -1
}
/**
 * Canonical public URL for a registered public object (SPEC-CMI-UX-001 §5.2).
 *
 * This is a read-only projection helper: the base is derived from the
 * object's own provider config (or the env bootstrap), never from a
 * client-supplied URL. `providerConfigId == null` → env bootstrap
 * (config.storage, memory adapter uses its upload base); otherwise the
 * provider's publicUrlBase (or endpoint/bucket) is used.
 */
export async function resolvePublicObjectCanonicalUrl(
  providerConfigId: number | null,
  objectKey: string,
  db: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<string | null> {
  if (providerConfigId == null) {
    if (config.storage.kind === 's3') {
      const base = config.storage.publicUrlBase
        ?? `${config.storage.endpoint.replace(/\/$/, '')}/${config.storage.bucket}`
      return `${base.replace(/\/$/, '')}/${objectKey}`
    }
    // memory adapter: uploads are served under the app's /uploads/ passthrough.
    return `http://localhost:3000/uploads/${objectKey}`
  }

  const row = await db.storageProviderConfig.findUnique({
    where: { id: providerConfigId },
  })
  if (!row) return null
  const pc = row.publicConfig as unknown as ProviderPublicConfig
  const base = pc.publicUrlBase ?? `${pc.endpoint.replace(/\/$/, '')}/${pc.publicBucket}`
  return `${base.replace(/\/$/, '')}/${objectKey}`
}

/** 测试钩子：重置全部缓存。 */
export function __resetStorageRuntimeForTesting(): void {
  bootstrapPair = null
  activePair = null
  testOverridePair = null
  cachedRuntimeVersion = -1
  lastVersionCheckAt = 0
  refreshPromise = null
}

export function __setPublicStorageForTesting(adapter: StorageAdapter | null): void {
  if (!adapter) {
    testOverridePair = null
    return
  }
  const priv = testOverridePair?.private ?? new DeliveryMemoryStorage()
  testOverridePair = {
    public: adapter,
    private: priv,
    configId: null,
    configVersion: 0,
  }
}

export function __setDeliveryStorageForTesting(adapter: DeliveryStorage | null): void {
  if (!adapter) {
    if (testOverridePair) {
      testOverridePair = {
        ...testOverridePair,
        private: new DeliveryMemoryStorage(),
      }
    }
    return
  }
  const pub = testOverridePair?.public ?? new MemoryStorageAdapter()
  testOverridePair = {
    public: pub,
    private: adapter,
    configId: null,
    configVersion: 0,
  }
}

export function getBootstrapDiagnostics() {
  const boot = config.storage
  if (boot.kind === 'memory') {
    return {
      kind: 'memory' as const,
      providerLabel: '进程内存（仅开发/测试）',
      endpointHost: null as string | null,
      region: null as string | null,
      publicBucket: null as string | null,
      privateBucket: null as string | null,
      publicUrlBaseConfigured: false,
      forcePathStyle: true,
    }
  }
  let endpointHost: string | null = null
  try {
    endpointHost = new URL(boot.endpoint).hostname
  } catch {
    endpointHost = '(invalid)'
  }
  return {
    kind: 's3' as const,
    providerLabel: 'MinIO / 环境变量底座',
    endpointHost,
    region: boot.region,
    publicBucket: boot.bucket,
    privateBucket: config.deliveryStorage.kind === 's3' ? config.deliveryStorage.bucket : null,
    publicUrlBaseConfigured: Boolean(boot.publicUrlBase),
    forcePathStyle: boot.forcePathStyle,
  }
}
