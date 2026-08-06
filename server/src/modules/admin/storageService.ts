import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, forbidden, notFound } from '../../lib/httpError.js'
import {
  encryptStorageCredentials,
  decryptStorageCredentials,
} from '../../lib/storage/credentialsCrypto.js'
import { assertSafeStorageEndpoint } from '../../lib/storage/endpointGuard.js'
import { probeStorageProvider } from '../../lib/storage/probe.js'
import {
  PROVIDER_PRESETS,
  type ProviderPublicConfig,
  type StorageProviderType,
} from '../../lib/storage/providerPresets.js'
import {
  getBootstrapDiagnostics,
  invalidateStorageRuntimeCache,
} from '../../lib/storage/runtime.js'
import type {
  CreateStorageProviderInput,
  UpdateStorageProviderInput,
} from './storageSchema.js'

function assertUiWritable() {
  if (!config.storageUiConfigEnabled) {
    throw forbidden('对象存储控制台写操作已关闭（STORAGE_UI_CONFIG_ENABLED=false）')
  }
  if (config.isProduction && !config.storageCredentialsEncKey) {
    throw forbidden('生产环境未配置 STORAGE_CREDENTIALS_ENC_KEY，无法保存云存储凭证')
  }
}

function parsePublicConfig(raw: unknown): ProviderPublicConfig {
  const c = raw as ProviderPublicConfig
  if (!c?.endpoint || !c.publicBucket || !c.privateBucket) {
    throw badRequest('publicConfig 缺少 endpoint 或桶名')
  }
  return {
    endpoint: c.endpoint.trim(),
    region: (c.region || 'us-east-1').trim(),
    publicBucket: c.publicBucket.trim(),
    privateBucket: c.privateBucket.trim(),
    publicUrlBase: c.publicUrlBase?.trim() || undefined,
    deliveryPublicEndpoint: c.deliveryPublicEndpoint?.trim() || undefined,
    forcePathStyle: Boolean(c.forcePathStyle),
  }
}

async function validatePublicConfig(pc: ProviderPublicConfig) {
  if (pc.publicBucket === pc.privateBucket) {
    throw badRequest('公有桶与私有桶名称必须不同')
  }
  await assertSafeStorageEndpoint(pc.endpoint)
  if (pc.publicUrlBase) {
    // Probe may server-side GET this URL — apply same SSRF guard as endpoint
    await assertSafeStorageEndpoint(pc.publicUrlBase)
  }
  if (pc.deliveryPublicEndpoint) {
    await assertSafeStorageEndpoint(pc.deliveryPublicEndpoint)
  }
}

function serializeProvider(row: {
  id: number
  type: string
  name: string
  status: string
  configVersion: number
  publicConfig: unknown
  accessKeyLast4: string | null
  lastTestAt: Date | null
  lastTestOk: boolean | null
  lastTestSummary: string | null
  verifiedAt: Date | null
  activatedAt: Date | null
  disabledAt: Date | null
  previousActiveId: number | null
  createdAt: Date
  updatedAt: Date
  credentialsCiphertext: string | null
}) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    configVersion: row.configVersion,
    publicConfig: row.publicConfig,
    accessKeyConfigured: Boolean(row.credentialsCiphertext),
    accessKeyLast4: row.accessKeyLast4,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestSummary: row.lastTestSummary,
    verifiedAt: row.verifiedAt,
    activatedAt: row.activatedAt,
    disabledAt: row.disabledAt,
    previousActiveId: row.previousActiveId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getStorageStatus() {
  const bootstrap = getBootstrapDiagnostics()
  let healthy = true
  let healthDetail = 'ok'
  if (bootstrap.kind === 'memory') {
    healthy = !config.isProduction
    healthDetail = config.isProduction ? 'production must not use memory storage' : 'memory adapter'
  }

  let decryptOk: boolean | null = null
  const runtime = await prisma.storageRuntime.findUnique({ where: { id: 1 } })
  if (runtime?.activeConfigId) {
    const active = await prisma.storageProviderConfig.findUnique({
      where: { id: runtime.activeConfigId },
    })
    if (active?.credentialsCiphertext) {
      try {
        decryptStorageCredentials(active.credentialsCiphertext)
        decryptOk = true
      } catch {
        decryptOk = false
        healthy = false
        healthDetail = 'active provider credentials cannot be decrypted'
      }
    }
  }

  const writeTarget =
    config.storageConfigSource === 'env'
      ? 'bootstrap'
      : runtime?.activeConfigId
        ? 'provider'
        : 'bootstrap'

  return {
    uiConfigEnabled: config.storageUiConfigEnabled,
    configSource: config.storageConfigSource,
    credentialsEncKeyConfigured: Boolean(config.storageCredentialsEncKey) || !config.isProduction,
    bootstrap: {
      ...bootstrap,
      healthy,
      healthDetail,
    },
    runtime: {
      activeConfigId: runtime?.activeConfigId ?? null,
      configVersion: runtime?.configVersion ?? 0,
      writeTarget,
      activeCredentialsDecryptOk: decryptOk,
    },
    presets: PROVIDER_PRESETS,
  }
}

export async function listStorageProviders() {
  const rows = await prisma.storageProviderConfig.findMany({
    orderBy: { id: 'desc' },
  })
  return { items: rows.map(serializeProvider) }
}

export async function createStorageProvider(
  adminUserId: number,
  input: CreateStorageProviderInput,
) {
  assertUiWritable()
  const publicConfig = parsePublicConfig(input.publicConfig)
  await validatePublicConfig(publicConfig)

  if (!input.accessKey?.trim() || !input.secretKey?.trim()) {
    throw badRequest('创建配置时必须提供 accessKey 与 secretKey')
  }

  const enc = encryptStorageCredentials({
    accessKey: input.accessKey.trim(),
    secretKey: input.secretKey.trim(),
  })

  const row = await prisma.$transaction(async tx => {
    const created = await tx.storageProviderConfig.create({
      data: {
        type: input.type,
        name: input.name.trim(),
        status: 'draft',
        configVersion: 1,
        publicConfig: publicConfig as unknown as Prisma.InputJsonValue,
        credentialsCiphertext: enc.ciphertext,
        credentialsKeyVersion: enc.keyVersion,
        accessKeyLast4: enc.accessKeyLast4,
        createdById: adminUserId,
      },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '创建存储配置',
        targetType: 'storage_provider',
        targetId: created.id,
        detail: JSON.stringify({ type: input.type, name: input.name }),
      },
    })
    return created
  })

  return serializeProvider(row)
}

export async function updateStorageProvider(
  adminUserId: number,
  id: number,
  input: UpdateStorageProviderInput,
) {
  assertUiWritable()
  const existing = await prisma.storageProviderConfig.findUnique({ where: { id } })
  if (!existing) throw notFound('存储配置不存在')
  if (existing.status === 'active') {
    throw badRequest('已激活的配置不可直接编辑；请新建配置或先回滚')
  }
  if (existing.status === 'disabled') {
    throw badRequest('已禁用的配置不可编辑')
  }

  const publicConfig = input.publicConfig
    ? parsePublicConfig(input.publicConfig)
    : (existing.publicConfig as unknown as ProviderPublicConfig)
  if (input.publicConfig) await validatePublicConfig(publicConfig)

  let credentialsCiphertext = existing.credentialsCiphertext
  let credentialsKeyVersion = existing.credentialsKeyVersion
  let accessKeyLast4 = existing.accessKeyLast4

  if (input.secretKey?.trim() || input.accessKey?.trim()) {
    if (!input.accessKey?.trim() || !input.secretKey?.trim()) {
      throw badRequest('更新密钥时必须同时提供 accessKey 与 secretKey')
    }
    const enc = encryptStorageCredentials({
      accessKey: input.accessKey.trim(),
      secretKey: input.secretKey.trim(),
    })
    credentialsCiphertext = enc.ciphertext
    credentialsKeyVersion = enc.keyVersion
    accessKeyLast4 = enc.accessKeyLast4
  }

  const row = await prisma.$transaction(async tx => {
    const updated = await tx.storageProviderConfig.update({
      where: { id },
      data: {
        name: input.name?.trim() ?? existing.name,
        type: (input.type as StorageProviderType | undefined) ?? existing.type,
        publicConfig: publicConfig as unknown as Prisma.InputJsonValue,
        credentialsCiphertext,
        credentialsKeyVersion,
        accessKeyLast4,
        status: 'draft',
        configVersion: { increment: 1 },
        verifiedAt: null,
        lastTestOk: null,
        lastTestSummary: null,
      },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新存储配置',
        targetType: 'storage_provider',
        targetId: id,
        detail: JSON.stringify({ configVersion: updated.configVersion }),
      },
    })
    return updated
  })

  return serializeProvider(row)
}

export async function testStorageProvider(adminUserId: number, id: number) {
  assertUiWritable()
  const row = await prisma.storageProviderConfig.findUnique({ where: { id } })
  if (!row) throw notFound('存储配置不存在')
  if (!row.credentialsCiphertext) throw badRequest('配置缺少凭证')

  const publicConfig = parsePublicConfig(row.publicConfig)
  await validatePublicConfig(publicConfig)

  let credentials
  try {
    credentials = decryptStorageCredentials(row.credentialsCiphertext)
  } catch {
    throw badRequest('凭证解密失败，请检查 STORAGE_CREDENTIALS_ENC_KEY')
  }

  const result = await probeStorageProvider({ publicConfig, credentials })

  const updated = await prisma.$transaction(async tx => {
    const next = await tx.storageProviderConfig.update({
      where: { id },
      data: {
        lastTestAt: new Date(),
        lastTestOk: result.ok,
        lastTestSummary: result.summary.slice(0, 500),
        ...(result.ok
          ? {
              status: row.status === 'active' ? 'active' : 'verified',
              verifiedAt: new Date(),
            }
          : {}),
      },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '测试存储配置',
        targetType: 'storage_provider',
        targetId: id,
        detail: JSON.stringify({ ok: result.ok, summary: result.summary }),
      },
    })
    return next
  })

  return {
    provider: serializeProvider(updated),
    probe: result,
  }
}

export async function activateStorageProvider(adminUserId: number, id: number) {
  assertUiWritable()
  if (config.storageConfigSource === 'env') {
    throw forbidden('STORAGE_CONFIG_SOURCE=env：已熔断，禁止激活数据库存储配置')
  }

  const row = await prisma.storageProviderConfig.findUnique({ where: { id } })
  if (!row) throw notFound('存储配置不存在')
  if (row.status !== 'verified' && row.status !== 'active') {
    throw badRequest('仅已通过测试的配置可激活')
  }
  if (!row.credentialsCiphertext) throw badRequest('配置缺少凭证')

  try {
    decryptStorageCredentials(row.credentialsCiphertext)
  } catch {
    throw badRequest('凭证解密失败，请检查 STORAGE_CREDENTIALS_ENC_KEY')
  }

  const publicConfig = parsePublicConfig(row.publicConfig)
  await validatePublicConfig(publicConfig)

  // ST-06：事务内锁 runtime 行 + 部分唯一索引保证至多一个 active
  const updated = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT id FROM "StorageRuntime" WHERE id = 1 FOR UPDATE`
    // Ensure runtime row exists under the lock
    await tx.storageRuntime.upsert({
      where: { id: 1 },
      create: { id: 1, activeConfigId: null, configVersion: 0 },
      update: {},
    })

    const currentActive = await tx.storageProviderConfig.findFirst({
      where: { status: 'active' },
    })

    if (currentActive && currentActive.id !== id) {
      await tx.storageProviderConfig.update({
        where: { id: currentActive.id },
        data: { status: 'disabled', disabledAt: new Date() },
      })
    }

    // CAS: only promote if still verified/active (not disabled mid-flight)
    const promoted = await tx.storageProviderConfig.updateMany({
      where: { id, status: { in: ['verified', 'active'] } },
      data: {
        status: 'active',
        activatedAt: new Date(),
        activatedById: adminUserId,
        previousActiveId:
          currentActive && currentActive.id !== id ? currentActive.id : row.previousActiveId,
        disabledAt: null,
        configVersion: { increment: 1 },
      },
    })
    if (promoted.count !== 1) {
      throw badRequest('激活失败：配置状态已变更，请刷新后重试')
    }

    const next = await tx.storageProviderConfig.findUniqueOrThrow({ where: { id } })

    await tx.storageRuntime.update({
      where: { id: 1 },
      data: {
        activeConfigId: id,
        configVersion: next.configVersion,
      },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '激活存储配置',
        targetType: 'storage_provider',
        targetId: id,
        detail: JSON.stringify({
          previousActiveId: currentActive?.id ?? null,
          configVersion: next.configVersion,
        }),
      },
    })

    return next
  })

  invalidateStorageRuntimeCache()
  return serializeProvider(updated)
}

export async function rollbackStorageProvider(adminUserId: number, id: number) {
  assertUiWritable()
  if (config.storageConfigSource === 'env') {
    throw forbidden('STORAGE_CONFIG_SOURCE=env：已熔断，禁止变更激活状态')
  }

  const row = await prisma.storageProviderConfig.findUnique({ where: { id } })
  if (!row) throw notFound('存储配置不存在')
  if (row.status !== 'active') {
    throw badRequest('只能从当前激活配置回滚')
  }

  const previousId = row.previousActiveId

  // Single transaction: disable current + restore previous (or bootstrap) + runtime
  const updated = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT id FROM "StorageRuntime" WHERE id = 1 FOR UPDATE`
    await tx.storageRuntime.upsert({
      where: { id: 1 },
      create: { id: 1, activeConfigId: null, configVersion: 0 },
      update: {},
    })

    let previous: { id: number; credentialsCiphertext: string | null } | null = null
    if (previousId) {
      previous = await tx.storageProviderConfig.findUnique({
        where: { id: previousId },
        select: { id: true, credentialsCiphertext: true },
      })
    }

    // Disable current active
    const next = await tx.storageProviderConfig.update({
      where: { id },
      data: { status: 'disabled', disabledAt: new Date() },
    })

    if (previous?.credentialsCiphertext) {
      try {
        decryptStorageCredentials(previous.credentialsCiphertext)
      } catch {
        throw badRequest('上一配置凭证无法解密，回滚已取消')
      }
      const promoted = await tx.storageProviderConfig.updateMany({
        where: { id: previous.id, status: { in: ['verified', 'disabled', 'draft', 'active'] } },
        data: {
          status: 'active',
          activatedAt: new Date(),
          activatedById: adminUserId,
          disabledAt: null,
          verifiedAt: new Date(),
          configVersion: { increment: 1 },
        },
      })
      if (promoted.count !== 1) {
        throw badRequest('回滚失败：无法恢复上一配置')
      }
      const restored = await tx.storageProviderConfig.findUniqueOrThrow({ where: { id: previous.id } })
      await tx.storageRuntime.update({
        where: { id: 1 },
        data: { activeConfigId: previous.id, configVersion: restored.configVersion },
      })
      await tx.adminLog.create({
        data: {
          adminUserId,
          action: '回滚存储配置',
          targetType: 'storage_provider',
          targetId: id,
          detail: JSON.stringify({ to: previous.id }),
        },
      })
      return restored
    }

    // Bootstrap only
    await tx.storageRuntime.update({
      where: { id: 1 },
      data: { activeConfigId: null, configVersion: { increment: 1 } },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '回滚存储配置',
        targetType: 'storage_provider',
        targetId: id,
        detail: JSON.stringify({ to: 'bootstrap' }),
      },
    })
    return next
  })

  invalidateStorageRuntimeCache()
  return serializeProvider(updated)
}

export async function disableStorageProvider(adminUserId: number, id: number) {
  assertUiWritable()
  const row = await prisma.storageProviderConfig.findUnique({ where: { id } })
  if (!row) throw notFound('存储配置不存在')
  if (row.status === 'active') {
    throw badRequest('请先回滚激活配置，再禁用')
  }

  const updated = await prisma.$transaction(async tx => {
    const next = await tx.storageProviderConfig.update({
      where: { id },
      data: { status: 'disabled', disabledAt: new Date() },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '禁用存储配置',
        targetType: 'storage_provider',
        targetId: id,
        detail: '{}',
      },
    })
    return next
  })

  return serializeProvider(updated)
}
