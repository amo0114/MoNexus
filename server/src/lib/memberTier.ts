import { prisma } from './prisma.js'

export type MemberTier = 'bronze' | 'silver' | 'gold' | 'platinum'
export type MemberTierTone = 'neutral' | 'info' | 'warning' | 'success'

export interface TierThresholds {
  silver: number
  gold: number
  platinum: number
}

export interface TierBonusBps {
  bronze: 0
  silver: number
  gold: number
  platinum: number
}

export interface TierConfig {
  thresholds: TierThresholds
  bonusBps: TierBonusBps
}

export interface TierResponseDTO {
  tier: MemberTier
  label: string
  tone: MemberTierTone
  lifetimeEarnedPoints: number
  bonusBps: number
  thresholds: TierThresholds
  nextTier: Exclude<MemberTier, 'bronze'> | null
  pointsToNextTier: number
}

export const TIER_CONFIG_FALLBACK: TierConfig = {
  thresholds: { silver: 1000, gold: 5000, platinum: 20000 },
  bonusBps: { bronze: 0, silver: 500, gold: 1000, platinum: 2000 },
}

const TIER_CONFIG_KEYS = [
  'memberTierSilverThreshold',
  'memberTierGoldThreshold',
  'memberTierPlatinumThreshold',
  'memberTierSilverBonusBps',
  'memberTierGoldBonusBps',
  'memberTierPlatinumBonusBps',
] as const

const tierMeta: Record<MemberTier, { label: string; tone: MemberTierTone }> = {
  bronze: { label: '普通会员', tone: 'neutral' },
  silver: { label: '银卡', tone: 'info' },
  gold: { label: '金卡', tone: 'warning' },
  platinum: { label: '铂金', tone: 'success' },
}

const nextTierByTier: Record<MemberTier, Exclude<MemberTier, 'bronze'> | null> = {
  bronze: 'silver',
  silver: 'gold',
  gold: 'platinum',
  platinum: null,
}

export async function computeLifetimeEarnedPoints(userId: number): Promise<number> {
  const result = await prisma.pointLog.aggregate({
    where: { userId, type: 'in' },
    _sum: { amount: true },
  })
  return result._sum.amount ?? 0
}

export async function getCurrentTierConfig(): Promise<TierConfig> {
  const rows = await prisma.systemConfig.findMany({
    where: {
      key: {
        in: [...TIER_CONFIG_KEYS],
      },
    },
    select: { key: true, value: true },
  })
  const byKey = new Map(rows.map(row => [row.key, row.value]))

  return {
    thresholds: {
      silver: byKey.get('memberTierSilverThreshold') ?? TIER_CONFIG_FALLBACK.thresholds.silver,
      gold: byKey.get('memberTierGoldThreshold') ?? TIER_CONFIG_FALLBACK.thresholds.gold,
      platinum: byKey.get('memberTierPlatinumThreshold') ?? TIER_CONFIG_FALLBACK.thresholds.platinum,
    },
    bonusBps: {
      bronze: 0,
      silver: byKey.get('memberTierSilverBonusBps') ?? TIER_CONFIG_FALLBACK.bonusBps.silver,
      gold: byKey.get('memberTierGoldBonusBps') ?? TIER_CONFIG_FALLBACK.bonusBps.gold,
      platinum: byKey.get('memberTierPlatinumBonusBps') ?? TIER_CONFIG_FALLBACK.bonusBps.platinum,
    },
  }
}

export function resolveTier(lifetime: number, thresholds: TierThresholds): MemberTier {
  const points = Math.max(0, Math.floor(lifetime))

  if (points >= thresholds.platinum) return 'platinum'
  if (points >= thresholds.gold) return 'gold'
  if (points >= thresholds.silver) return 'silver'
  return 'bronze'
}

export function applyTierBonus(
  baseAmount: number,
  tier: MemberTier,
  bonusBps: TierBonusBps
): { base: number; bonus: number; total: number } {
  const base = Math.max(0, Math.floor(baseAmount))
  const bps = Math.max(0, Math.floor(bonusBps[tier]))
  const bonus = Math.floor(base * bps / 10000)

  return { base, bonus, total: base + bonus }
}

export function formatTierResponse(
  userId: number,
  lifetime: number,
  tier: MemberTier,
  config: TierConfig
): TierResponseDTO {
  void userId

  const nextTier = nextTierByTier[tier]
  const pointsToNextTier = nextTier
    ? Math.max(0, config.thresholds[nextTier] - lifetime)
    : 0

  return {
    tier,
    label: tierMeta[tier].label,
    tone: tierMeta[tier].tone,
    lifetimeEarnedPoints: lifetime,
    bonusBps: config.bonusBps[tier],
    thresholds: config.thresholds,
    nextTier,
    pointsToNextTier,
  }
}
