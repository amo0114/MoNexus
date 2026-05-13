import { Prisma } from '@prisma/client'
import { config } from '../config/index.js'
import { badRequest } from './httpError.js'
import { prisma } from './prisma.js'

export const systemConfigKeys = [
  'registerReward',
  'checkinReward',
  'inviteReward',
  'refreshTokenMaxAgeDays',
] as const

export type SystemConfigKey = typeof systemConfigKeys[number]

const oneDayMs = 24 * 60 * 60 * 1000

export const systemConfigDefaults: Record<SystemConfigKey, number> = {
  registerReward: config.registerReward,
  checkinReward: config.checkinReward,
  inviteReward: config.inviteReward,
  refreshTokenMaxAgeDays: Math.floor(config.refreshTokenMaxAgeMs / oneDayMs),
}

const descriptions: Record<SystemConfigKey, string> = {
  registerReward: '新用户注册奖励积分',
  checkinReward: '每日签到奖励积分',
  inviteReward: '邀请新用户奖励积分',
  refreshTokenMaxAgeDays: 'Refresh Token 有效天数',
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
