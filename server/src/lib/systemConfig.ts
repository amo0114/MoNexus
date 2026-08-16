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
  // 结算高风险二次验证阈值（0 = 关闭该维度）
  'checkoutVerifyAmountThreshold',
  'checkoutVerifyDailyThreshold',
  // P5 受控文件交付
  'fileUrlTtlSeconds',
  'fileAccessWindowDays',
  'deliveryFileMaxMb',
  // P5.5 低库存邮件告警重发冷却（0 = 进入低位只发一次，不重发）
  'lowStockNotifyCooldownHours',
  // P6a 订单计时配置化（原硬编码 7 天）
  'autoCloseDays',
  'fulfillmentSlaDays',
  // P6a 订阅到期前提醒提前天数（0 = 关闭到期前提醒，仅到期时提醒）
  'subscriptionRemindDays',
  // P7b 自动开通外呼最大尝试次数（0 = 运维刹车：只建任务不外呼不转状态）
  'autoProvisionMaxAttempts',
  // SPEC-OPS-REGMAIL-001 公开注册总开关（1 = 开启，0 = 关闭）
  'registrationEnabled',
  // SPEC-RAP-001：邮箱资格、奖励冷静期与邀请码额度。
  'emailVerificationRequiredForValue',
  'growthRewardHoldDays',
  'referralInviterMinAgeDays',
  'referralDailyQualifiedLimit',
  'referralLifetimeQualifiedLimit',
  // SPEC-INVITE-001：invite-only 开关、发码资格门槛、周期名额与码有效期。
  'registrationInviteOnly',
  'inviteMinTierRank',
  'inviteQuotaUserMonthly',
  'inviteQuotaMerchantMonthly',
  'inviteCodeTtlDays',
  // SPEC-MERCH-001 §12：自然热卖与合作伙伴权益（F0 shared constants）。
  'hotWindowDays',
  'hotMinSales',
  'hotTopPercent',
  'hotRecomputeMinutes',
  'hotRunTimeoutMinutes',
  'partnerSpendWindowDays',
  'partnerMinPromotionPoints',
  'partnerEntitlementDays',
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
  checkoutVerifyAmountThreshold: 0,
  checkoutVerifyDailyThreshold: 0,
  fileUrlTtlSeconds: 300,
  fileAccessWindowDays: 30,
  deliveryFileMaxMb: 100,
  lowStockNotifyCooldownHours: 24,
  autoCloseDays: 7,
  fulfillmentSlaDays: 7,
  subscriptionRemindDays: 3,
  autoProvisionMaxAttempts: 5,
  // REG-01：缺记录默认开启，保证升级到本版本的站点行为不变。
  registrationEnabled: 1,
  // RAP-01：默认先保持未验证账户的既有交易兼容性，运营按发布流程再开启。
  emailVerificationRequiredForValue: 0,
  growthRewardHoldDays: 7,
  referralInviterMinAgeDays: 30,
  referralDailyQualifiedLimit: 3,
  referralLifetimeQualifiedLimit: 20,
  // SPEC-INVITE-001 IV-08/IV-12：默认关闭 invite-only、金卡门槛、3/10 枚月名额、14 天有效期。
  registrationInviteOnly: 0,
  inviteMinTierRank: 2,
  inviteQuotaUserMonthly: 3,
  inviteQuotaMerchantMonthly: 10,
  inviteCodeTtlDays: 14,
  // SPEC-MERCH-001 §12（F0）
  hotWindowDays: 30,
  hotMinSales: 5,
  hotTopPercent: 20,
  hotRecomputeMinutes: 60,
  hotRunTimeoutMinutes: 30,
  partnerSpendWindowDays: 90,
  partnerMinPromotionPoints: 1000,
  partnerEntitlementDays: 30,
}


export const systemConfigDescriptions: Record<SystemConfigKey, string> = {
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
  checkoutVerifyAmountThreshold: '单笔兑换需密码确认的金额阈值',
  checkoutVerifyDailyThreshold: '当日累计兑换需密码确认的金额阈值',
  fileUrlTtlSeconds: '文件下载签名链接有效期',
  fileAccessWindowDays: '买家交付后下载窗口天数',
  deliveryFileMaxMb: '交付文件大小上限',
  lowStockNotifyCooldownHours: '低库存邮件重发冷却时长',
  autoCloseDays: '已交付订单自动确认关闭天数',
  fulfillmentSlaDays: '人工服务履约时限天数',
  subscriptionRemindDays: '订阅到期前提醒提前天数',
  autoProvisionMaxAttempts: '自动开通外呼最大尝试次数',
  registrationEnabled: '允许新用户注册',
  emailVerificationRequiredForValue: '未验证邮箱的价值操作门槛',
  growthRewardHoldDays: '注册与邀请奖励冷静期',
  referralInviterMinAgeDays: '邀请码邀请人最小账户年龄',
  referralDailyQualifiedLimit: '邀请码每日合格人数上限',
  referralLifetimeQualifiedLimit: '邀请码生命周期合格人数上限',
  registrationInviteOnly: '仅限邀请注册',
  inviteMinTierRank: '普通用户发码会员等级门槛',
  inviteQuotaUserMonthly: '普通用户每月邀请名额',
  inviteQuotaMerchantMonthly: '商家每月邀请名额',
  inviteCodeTtlDays: '邀请码有效期',
  // SPEC-MERCH-001 §12（F0）
  hotWindowDays: '自然热卖统计窗口天数',
  hotMinSales: '自然热卖最低销量门槛',
  hotTopPercent: '自然热卖分类前百分之比',
  hotRecomputeMinutes: '自然热卖重算周期（分钟）',
  hotRunTimeoutMinutes: '排名 run 超时回收分钟数',
  partnerSpendWindowDays: '合作伙伴自动授予窗口天数',
  partnerMinPromotionPoints: '合作伙伴自动授予净推广消费积分阈值',
  partnerEntitlementDays: '合作伙伴权益授予天数',
}


/** 管理端配置项分组（中文），供配置页按组渲染。 */
export const systemConfigGroups: Record<SystemConfigKey, string> = {
  registerReward: '奖励发放',
  checkinReward: '奖励发放',
  inviteReward: '奖励发放',
  refreshTokenMaxAgeDays: '安全',
  defaultPageSize: '分页限制',
  maxPageSize: '分页限制',
  lowStockThreshold: '库存',
  memberTierSilverThreshold: '会员等级',
  memberTierGoldThreshold: '会员等级',
  memberTierPlatinumThreshold: '会员等级',
  memberTierSilverBonusBps: '会员等级',
  memberTierGoldBonusBps: '会员等级',
  memberTierPlatinumBonusBps: '会员等级',
  checkoutVerifyAmountThreshold: '安全',
  checkoutVerifyDailyThreshold: '安全',
  fileUrlTtlSeconds: '文件交付',
  fileAccessWindowDays: '文件交付',
  deliveryFileMaxMb: '文件交付',
  lowStockNotifyCooldownHours: '库存',
  autoCloseDays: '订单',
  fulfillmentSlaDays: '订单',
  subscriptionRemindDays: '订单',
  autoProvisionMaxAttempts: '订单',
  registrationEnabled: '账户与注册',
  emailVerificationRequiredForValue: '账户与注册',
  growthRewardHoldDays: '奖励发放',
  referralInviterMinAgeDays: '账户与注册',
  referralDailyQualifiedLimit: '账户与注册',
  referralLifetimeQualifiedLimit: '账户与注册',
  registrationInviteOnly: '账户与注册',
  inviteMinTierRank: '账户与注册',
  inviteQuotaUserMonthly: '账户与注册',
  inviteQuotaMerchantMonthly: '账户与注册',
  inviteCodeTtlDays: '账户与注册',
  // SPEC-MERCH-001 §12（F0）
  hotWindowDays: '商品运营',
  hotMinSales: '商品运营',
  hotTopPercent: '商品运营',
  hotRecomputeMinutes: '商品运营',
  hotRunTimeoutMinutes: '商品运营',
  partnerSpendWindowDays: '商品运营',
  partnerMinPromotionPoints: '商品运营',
  partnerEntitlementDays: '商品运营',
}


/** 可选单位标注。 */
export const systemConfigUnits: Partial<Record<SystemConfigKey, string>> = {
  registerReward: '积分',
  checkinReward: '积分',
  inviteReward: '积分',
  refreshTokenMaxAgeDays: '天',
  defaultPageSize: '条/页',
  maxPageSize: '条/页',
  lowStockThreshold: '件',
  memberTierSilverThreshold: '积分',
  memberTierGoldThreshold: '积分',
  memberTierPlatinumThreshold: '积分',
  memberTierSilverBonusBps: 'bps',
  memberTierGoldBonusBps: 'bps',
  memberTierPlatinumBonusBps: 'bps',
  checkoutVerifyAmountThreshold: '积分',
  checkoutVerifyDailyThreshold: '积分',
  fileUrlTtlSeconds: '秒',
  fileAccessWindowDays: '天',
  deliveryFileMaxMb: 'MB',
  lowStockNotifyCooldownHours: '小时',
  autoCloseDays: '天',
  fulfillmentSlaDays: '天',
  subscriptionRemindDays: '天',
  autoProvisionMaxAttempts: '次',
  emailVerificationRequiredForValue: '开关（0/1）',
  growthRewardHoldDays: '天',
  referralInviterMinAgeDays: '天',
  referralDailyQualifiedLimit: '人/日',
  referralLifetimeQualifiedLimit: '人',
  registrationInviteOnly: '开关（0/1）',
  inviteMinTierRank: '等级序号',
  inviteQuotaUserMonthly: '枚/月',
  inviteQuotaMerchantMonthly: '枚/月',
  inviteCodeTtlDays: '天',
  // SPEC-MERCH-001 §12（F0）
  hotWindowDays: '天',
  hotMinSales: '单',
  hotTopPercent: '%',
  hotRecomputeMinutes: '分钟',
  hotRunTimeoutMinutes: '分钟',
  partnerSpendWindowDays: '天',
  partnerMinPromotionPoints: '积分',
  partnerEntitlementDays: '天',
}


const BONUS_BPS_HINT = '万分比，10000=100%；例如 500 表示额外 +5%'

/** 可选填写提示，配置页用于校验说明。 */
export const systemConfigHints: Partial<Record<SystemConfigKey, string>> = {
  refreshTokenMaxAgeDays: '修改后对新签发的 Refresh Token 生效',
  defaultPageSize: '列表接口未显式传 pageSize 时使用，需 ≤ 最大分页大小',
  maxPageSize: '请求 pageSize 超过该值会被拒绝或截断',
  lowStockThreshold: '即时库存商品可用库存 ≤ 该值时触发低库存预警',
  memberTierSilverThreshold: '需满足 银卡 < 金卡 < 铂金',
  memberTierGoldThreshold: '需满足 银卡 < 金卡 < 铂金',
  memberTierPlatinumThreshold: '需满足 银卡 < 金卡 < 铂金',
  memberTierSilverBonusBps: BONUS_BPS_HINT,
  memberTierGoldBonusBps: BONUS_BPS_HINT,
  memberTierPlatinumBonusBps: BONUS_BPS_HINT,
  checkoutVerifyAmountThreshold: '单笔兑换金额 ≥ 该值时要求输入登录密码确认；0 表示关闭',
  checkoutVerifyDailyThreshold: '当日已成交累计 + 本单 ≥ 该值时要求输入登录密码确认；0 表示关闭',
  fileUrlTtlSeconds: '签名一经签出在有效期内无法撤销，建议保持短时；上限 3600',
  fileAccessWindowDays: '从交付时刻起算；0 表示不限窗口',
  deliveryFileMaxMb: '上限 100（与 Nginx 上传路由的 100MB 限制一致，提额需同步修改 Nginx）',
  lowStockNotifyCooldownHours: '规格持续低库存时的邮件重发间隔；0 表示进入低位只发一次；上限 720',
  autoCloseDays: '买家未确认时交付后自动关闭并结算的天数；1–90，对新一轮巡检生效',
  fulfillmentSlaDays: '下单后商家须完成人工履约的天数；1–90，仅影响新订单',
  subscriptionRemindDays: '到期前 N 天邮件提醒买家；0 = 关闭到期前提醒；上限 30',
  autoProvisionMaxAttempts: '固定退避档 1m/5m/15m/1h/6h，上限 5；0 = 暂停外呼（只建任务，不转状态），已有任务恢复后按退避继续',
  registrationEnabled: '关闭后仅阻止新账号自助注册；现有账号仍可登录。',
  emailVerificationRequiredForValue: '1 = 未验证邮箱不能下单、签到等价值操作；0 = 保持兼容。',
  growthRewardHoldDays: '邮箱验证后等待 N 天再发放注册和邀请奖励；0 = 即时发放，会提高滥用风险。',
  referralInviterMinAgeDays: '邀请码仅在邀请人账户年龄达到该值后才能建立新的邀请关系。',
  referralDailyQualifiedLimit: '每位邀请人每个上海自然日最多合格人数；0 = 暂停后续邀请资格，非 0 时不得超过生命周期上限。',
  referralLifetimeQualifiedLimit: '每位邀请人生命周期最多合格人数；0 = 暂停后续邀请资格。',
  registrationInviteOnly: '1 = 注册必须携带有效邀请码；0 = 邀请码可选。',
  inviteMinTierRank: '普通用户生成邀请码的最低会员等级：0 = 不限，1 = 银卡，2 = 金卡，3 = 铂金。',
  inviteQuotaUserMonthly: '普通合格用户每个上海自然月可生成的邀请码数；生成即消耗，过期不返还；0 = 暂停普通用户发码。',
  inviteQuotaMerchantMonthly: '商家每个上海自然月可生成的邀请码数；生成即消耗，过期不返还；0 = 暂停商家发码。',
  inviteCodeTtlDays: '邀请码自生成起的有效天数（1–90），过期未用不返还名额。',
  // SPEC-MERCH-001 §12（F0）：整数范围与 DB CHECK 一致。
  hotWindowDays: '自然热卖统计窗口 1–365 天',
  hotMinSales: '自然热卖最低销量门槛 1–100000',
  hotTopPercent: '自然热卖分类前百分之比 1–100',
  hotRecomputeMinutes: '自然热卖重算周期 10–1440 分钟',
  hotRunTimeoutMinutes: '排名 run 超时回收 10–1440 分钟',
  partnerSpendWindowDays: '合作伙伴自动授予窗口 1–365 天',
  partnerMinPromotionPoints: '合作伙伴自动授予净推广消费积分阈值 1–2000000000',
  partnerEntitlementDays: '合作伙伴权益授予 1–365 天',
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

/**
 * 布尔语义配置项：值域恰为 {0,1}。
 *
 * 单列一张表而不是用"非负整数 + 前端自觉"表达——把 2 写进 registrationEnabled
 * 会让"开关是否开启"取决于读取方的判定习惯（>0? ===1?），是典型的静默歧义。
 * 写入侧一律拒绝，读取侧再按 `=== 1` fail-closed（REG-02 / C2）。
 */
const BOOLEAN_CONFIG_KEYS = [
  'registrationEnabled',
  'emailVerificationRequiredForValue',
  'registrationInviteOnly',
] as const

/** 整数区间配置项：`min` 缺省时下界恒为 0（由非负整数守卫保证）。 */
type RangeConfigEntry = { min?: number; max: number; message: string }

const RANGE_CONFIG_KEYS = {
  growthRewardHoldDays: {
    max: 30,
    message: '奖励冷静期必须在 0..30 天之间',
  },
  referralInviterMinAgeDays: {
    max: 365,
    message: '邀请码邀请人最小账户年龄必须在 0..365 天之间',
  },
  referralDailyQualifiedLimit: {
    max: 100,
    message: '邀请码每日合格人数上限必须在 0..100 人之间（0 = 暂停资格）',
  },
  referralLifetimeQualifiedLimit: {
    max: 10_000,
    message: '邀请码生命周期合格人数上限必须在 0..10000 人之间（0 = 暂停资格）',
  },
  inviteMinTierRank: {
    max: 3,
    message: '发码会员等级门槛必须在 0..3 之间（0 = 不限，3 = 铂金）',
  },
  inviteQuotaUserMonthly: {
    max: 1_000,
    message: '普通用户每月邀请名额必须在 0..1000 枚之间（0 = 暂停发码）',
  },
  inviteQuotaMerchantMonthly: {
    max: 1_000,
    message: '商家每月邀请名额必须在 0..1000 枚之间（0 = 暂停发码）',
  },
  // SPEC-MERCH-001 §12（F0）：整数范围与 DB CHECK 完全一致。
  hotWindowDays: { min: 1, max: 365, message: '自然热卖统计窗口必须在 1..365 天之间' },
  hotMinSales: { min: 1, max: 100_000, message: '自然热卖最低销量门槛必须在 1..100000 之间' },
  hotTopPercent: { min: 1, max: 100, message: '自然热卖分类前百分之比必须在 1..100 之间' },
  hotRecomputeMinutes: { min: 10, max: 1440, message: '自然热卖重算周期必须在 10..1440 分钟之间' },
  hotRunTimeoutMinutes: { min: 10, max: 1440, message: '排名 run 超时回收必须在 10..1440 分钟之间' },
  partnerSpendWindowDays: { min: 1, max: 365, message: '合作伙伴自动授予窗口必须在 1..365 天之间' },
  partnerMinPromotionPoints: { min: 1, max: 2_000_000_000, message: '合作伙伴净推广消费积分阈值必须在 1..2000000000 之间' },
  partnerEntitlementDays: { min: 1, max: 365, message: '合作伙伴权益授予天数必须在 1..365 天之间' },
} as const satisfies Partial<Record<SystemConfigKey, RangeConfigEntry>>

function isBooleanConfigKey(key: SystemConfigKey): boolean {
  return (BOOLEAN_CONFIG_KEYS as readonly string[]).includes(key)
}

export function assertSystemConfigValue(key: SystemConfigKey, value: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest('配置值必须是非负整数')
  }
  if (isBooleanConfigKey(key) && value > 1) {
    throw badRequest('该开关只接受 0（关闭）或 1（开启）')
  }
  const range: RangeConfigEntry | undefined = RANGE_CONFIG_KEYS[key as keyof typeof RANGE_CONFIG_KEYS]
  if (range && ((range.min !== undefined && value < range.min) || value > range.max)) {
    throw badRequest(range.message)
  }
}

function isTierKey(key: SystemConfigKey): key is TierKey {
  return (TIER_KEYS as readonly string[]).includes(key)
}

const REFERRAL_QUOTA_KEYS = [
  'referralDailyQualifiedLimit',
  'referralLifetimeQualifiedLimit',
] as const

type ReferralQuotaKey = typeof REFERRAL_QUOTA_KEYS[number]

function isReferralQuotaKey(key: SystemConfigKey): key is ReferralQuotaKey {
  return (REFERRAL_QUOTA_KEYS as readonly string[]).includes(key)
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

interface EffectiveReferralQuotaConfig {
  daily: number
  lifetime: number
}

/**
 * Reads both related values through the same transaction that will write the
 * update. This avoids validating against a stale process-local/default view.
 */
async function loadEffectiveReferralQuotaConfig(
  tx: Prisma.TransactionClient,
  override?: { key: ReferralQuotaKey; value: number }
): Promise<EffectiveReferralQuotaConfig> {
  const rows = await tx.systemConfig.findMany({
    where: { key: { in: [...REFERRAL_QUOTA_KEYS] } },
    select: { key: true, value: true },
  })
  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const get = (key: ReferralQuotaKey): number =>
    override && override.key === key
      ? override.value
      : byKey.get(key) ?? systemConfigDefaults[key]

  return {
    daily: get('referralDailyQualifiedLimit'),
    lifetime: get('referralLifetimeQualifiedLimit'),
  }
}

function assertReferralQuotaConfigValid(effective: EffectiveReferralQuotaConfig) {
  // daily = 0 is an intentional operational pause and is therefore exempt
  // from the normal daily <= lifetime relationship.
  if (effective.daily !== 0 && effective.daily > effective.lifetime) {
    throw badRequest('邀请码每日合格人数上限不得超过生命周期上限（每日上限为 0 时表示暂停）')
  }
}

function formatSystemConfig(key: SystemConfigKey, row?: SystemConfigRow | null) {
  return {
    key,
    value: row?.value ?? systemConfigDefaults[key],
    defaultValue: systemConfigDefaults[key],
    description: systemConfigDescriptions[key],
    group: systemConfigGroups[key],
    unit: systemConfigUnits[key] ?? null,
    hint: systemConfigHints[key] ?? null,
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
  assertSystemConfigValue(key, value)

  // P5：签名有效期设上限——presigned URL 一经签出无法撤销，长 TTL 直接
  // 放大"链接被转发"的暴露窗口；0/负值也无意义。
  if (key === 'fileUrlTtlSeconds' && (value < 30 || value > 3600)) {
    throw badRequest('签名链接有效期必须在 30–3600 秒之间')
  }
  // 上限锁死 100：Nginx 对上传路由的 client_max_body_size 固定 100m，
  // 后台放开更大值只会让请求在反代处 413（评审 P1）。要提额必须同时改
  // Nginx 与此处（见 nginx.conf 上传 location 的注释）。
  if (key === 'deliveryFileMaxMb' && (value < 1 || value > 100)) {
    throw badRequest('交付文件大小上限必须在 1–100 MB 之间（Nginx 上传路由限制为 100MB）')
  }
  // P5.5：冷却上限 30 天——更长等于事实上关闭重发，直接填 0 表达该意图。
  if (key === 'lowStockNotifyCooldownHours' && value > 720) {
    throw badRequest('低库存邮件重发冷却必须在 0–720 小时之间（0 = 不重发）')
  }
  // P6a：0/负值会立即关单或立即超时，超长等于关闭机制——都拒绝。
  if ((key === 'autoCloseDays' || key === 'fulfillmentSlaDays') && (value < 1 || value > 90)) {
    throw badRequest('订单计时配置必须在 1–90 天之间')
  }
  if (key === 'subscriptionRemindDays' && value > 30) {
    throw badRequest('订阅到期提醒提前天数必须在 0–30 之间（0 = 关闭到期前提醒）')
  }
  // P7b：退避表只有五档，放开更大值只会让任务在最后一档上打转（硬验收 ⑥）。
  if (key === 'autoProvisionMaxAttempts' && value > 5) {
    throw badRequest('自动开通尝试次数必须在 0–5 之间（0 = 暂停外呼）')
  }
  // SPEC-INVITE-001 IV-11：0/负值等于生成即失效，超长有效期抵消一次性收敛。
  if (key === 'inviteCodeTtlDays' && (value < 1 || value > 90)) {
    throw badRequest('邀请码有效期必须在 1–90 天之间')
  }

  return prisma.$transaction(async tx => {
    if (isTierKey(key)) {
      const effective = await loadEffectiveTierConfig(tx, { key, value })
      assertTierConfigValid(effective)
    }
    if (isReferralQuotaKey(key)) {
      const effective = await loadEffectiveReferralQuotaConfig(tx, { key, value })
      assertReferralQuotaConfigValid(effective)
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
        description: systemConfigDescriptions[key],
        updatedBy: adminUserId,
      },
      update: {
        value,
        description: systemConfigDescriptions[key],
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
