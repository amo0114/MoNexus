import { Prisma } from '@prisma/client'
import { config } from '../config/index.js'
import { businessRegistry } from './businessRegistry.js'
import { badRequest } from './httpError.js'
import { prisma } from './prisma.js'

export const systemConfigKeys = [
  'registerReward',
  'checkinReward',
  'inviteReward',
  'refreshTokenMaxAgeDays',
  'defaultPageSize',
  'maxPageSize',
  'lowStockThreshold',
  'memberTierSilverThreshold',
  'memberTierGoldThreshold',
  'memberTierPlatinumThreshold',
  'memberTierSilverBonusBps',
  'memberTierGoldBonusBps',
  'memberTierPlatinumBonusBps',
] as const

export type SystemConfigKey = typeof systemConfigKeys[number]

const oneDayMs = 24 * 60 * 60 * 1000

const TIER_THRESHOLD_KEYS = [
  'memberTierSilverThreshold',
  'memberTierGoldThreshold',
  'memberTierPlatinumThreshold',
] as const

const TIER_BONUS_KEYS = [
  'memberTierSilverBonusBps',
  'memberTierGoldBonusBps',
  'memberTierPlatinumBonusBps',
] as const

const TIER_KEYS = [...TIER_THRESHOLD_KEYS, ...TIER_BONUS_KEYS] as const

type TierKey = typeof TIER_KEYS[number]

export const systemConfigDefaults: Record<SystemConfigKey, number> = {
  registerReward: config.registerReward,
  checkinReward: config.checkinReward,
  inviteReward: config.inviteReward,
  refreshTokenMaxAgeDays: Math.floor(config.refreshTokenMaxAgeMs / oneDayMs),
  defaultPageSize: businessRegistry.pagination.defaultPageSize,
  maxPageSize: businessRegistry.pagination.maxPageSize,
  lowStockThreshold: businessRegistry.inventory.lowStockThreshold,
  memberTierSilverThreshold: 1000,
  memberTierGoldThreshold: 5000,
  memberTierPlatinumThreshold: 20000,
  memberTierSilverBonusBps: 500,
  memberTierGoldBonusBps: 1000,
  memberTierPlatinumBonusBps: 2000,
}

const descriptions: Record<SystemConfigKey, string> = {
  registerReward: '新用户注册奖励积分',
  checkinReward: '每日签到奖励积分',
  inviteReward: '邀请新用户奖励积分',
  refreshTokenMaxAgeDays: 'Refresh Token 有效天数',
  defaultPageSize: '列表默认分页大小',
  maxPageSize: '列表最大分页大小',
  lowStockThreshold: '低库存提醒阈值',
  memberTierSilverThreshold: '银卡会员累计积分门槛',
  memberTierGoldThreshold: '金卡会员累计积分门槛',
  memberTierPlatinumThreshold: '铂金会员累计积分门槛',
  memberTierSilverBonusBps: '银卡签到/邀请奖励加成基点（万分之）',
  memberTierGoldBonusBps: '金卡签到/邀请奖励加成基点（万分之）',
  memberTierPlatinumBonusBps: '铂金签到/邀请奖励加成基点（万分之）',
}

type ConfigClient = typeof prisma | Prisma.TransactionClient

interface SystemConfigRow {
  value: number
  updatedAt: Date
  updatedBy: number | null
}

export function isSystemConfigKey(key: string): key is SystemConfigKey {
  return systemConfigKeys.includes(key as SystemConfigKey)
}

export function assertSystemConfigKey(key: string): asserts key is SystemConfigKey {
  if (!isSystemConfigKey(key)) {
    throw badRequest('未知系统配置项')
  }
}

export function assertSystemConfigValue(value: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest('配置值必须是非负整数')
  }
}

function isTierKey(key: SystemConfigKey): key is TierKey {
  return (TIER_KEYS as readonly string[]).includes(key)
}

interface EffectiveTierConfig {
  silver: number
  gold: number
  platinum: number
  silverBps: number
  goldBps: number
  platinumBps: number
}

async function loadEffectiveTierConfig(
  tx: Prisma.TransactionClient,
  override?: { key: TierKey; value: number }
): Promise<EffectiveTierConfig> {
  const rows = await tx.systemConfig.findMany({
    where: { key: { in: [...TIER_KEYS] } },
    select: { key: true, value: true },
  })
  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const get = (k: TierKey): number =>
    override && override.key === k
      ? override.value
      : byKey.get(k) ?? systemConfigDefaults[k]
  return {
    silver: get('memberTierSilverThreshold'),
    gold: get('memberTierGoldThreshold'),
    platinum: get('memberTierPlatinumThreshold'),
    silverBps: get('memberTierSilverBonusBps'),
    goldBps: get('memberTierGoldBonusBps'),
    platinumBps: get('memberTierPlatinumBonusBps'),
  }
}

function assertTierConfigValid(effective: EffectiveTierConfig) {
  if (!(effective.silver < effective.gold && effective.gold < effective.platinum)) {
    throw badRequest('会员等级阈值必须满足 银卡 < 金卡 < 铂金')
  }
  const bpsEntries: Array<[string, number]> = [
    ['银卡加成', effective.silverBps],
    ['金卡加成', effective.goldBps],
    ['铂金加成', effective.platinumBps],
  ]
  for (const [name, value] of bpsEntries) {
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
      throw badRequest(`${name}基点必须是 0..10000 之间的整数`)
    }
  }
}

function formatSystemConfig(key: SystemConfigKey, row?: SystemConfigRow | null) {
  return {
    key,
    value: row?.value ?? systemConfigDefaults[key],
    defaultValue: systemConfigDefaults[key],
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  }
}

export async function getSystemConfigValue(
  key: SystemConfigKey,
  tx?: Prisma.TransactionClient
) {
  const client: ConfigClient = tx ?? prisma
  const row = await client.systemConfig.findUnique({
    where: { key },
    select: { value: true },
  })

  return row?.value ?? systemConfigDefaults[key]
}

export async function getRefreshTokenMaxAgeMs(): Promise<number> {
  const days = await getSystemConfigValue('refreshTokenMaxAgeDays')
  if (typeof days === 'number' && days > 0) {
    return days * oneDayMs
  }
  return config.refreshTokenMaxAgeMs
}

export async function listSystemConfigs() {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: [...systemConfigKeys] } },
    select: { key: true, value: true, updatedAt: true, updatedBy: true },
  })
  const byKey = new Map(rows.map(row => [row.key, row]))

  return systemConfigKeys.map(key => formatSystemConfig(key, byKey.get(key)))
}

export async function updateSystemConfig(
  adminUserId: number,
  key: string,
  value: number
) {
  assertSystemConfigKey(key)
  assertSystemConfigValue(value)

  return prisma.$transaction(async tx => {
    if (isTierKey(key)) {
      const effective = await loadEffectiveTierConfig(tx, { key, value })
      assertTierConfigValid(effective)
    }

    const existing = await tx.systemConfig.findUnique({
      where: { key },
      select: { value: true },
    })

    const updated = await tx.systemConfig.upsert({
      where: { key },
      create: {
        key,
        value,
        description: descriptions[key],
        updatedBy: adminUserId,
      },
      update: {
        value,
        description: descriptions[key],
        updatedBy: adminUserId,
      },
      select: {
        value: true,
        updatedAt: true,
        updatedBy: true,
      },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新系统配置',
        targetType: 'systemConfig',
        detail: `${key}: ${existing?.value ?? systemConfigDefaults[key]} -> ${value}`,
      },
    })

    return formatSystemConfig(key, updated)
  })
}
