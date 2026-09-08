import { AdminSystemConfigKey } from '../../api/adminConfig'

export type ConfigGroupId =
  | 'registration' // 注册与邀请 (10)
  | 'rewards' // 基础奖励 (4)
  | 'memberTier' // 会员等级 (6)
  | 'trade' // 交易与交付 (9)
  | 'inventory' // 库存提醒 (2)
  | 'merchandising' // 商品运营 (8)
  | 'ops' // 高级运维 (3)

export interface ConfigGroupDef {
  id: ConfigGroupId
  title: string
  description: string
  legacyGroup?: string
}

export const CONFIG_GROUPS: ConfigGroupDef[] = [
  { id: 'registration', title: '注册与邀请', description: '新用户注册通道、邀请码要求与发码门槛配额' },
  { id: 'rewards', title: '基础奖励', description: '新用户注册、每日签到与邀请新用户的基础积分及冷静期', legacyGroup: '奖励发放' },
  { id: 'memberTier', title: '会员等级', description: '会员升级累计积分门槛与签到/邀请额外加成百分比', legacyGroup: '会员等级' },
  { id: 'trade', title: '交易与交付', description: '订单二次验证、交付文件与自动开通履约规则', legacyGroup: '安全' },
  { id: 'inventory', title: '库存提醒', description: '商品可用库存低位阈值与重发告警冷却', legacyGroup: '库存' },
  { id: 'merchandising', title: '商品运营', description: '自然热卖与合作伙伴权益自动计算参数' },
  { id: 'ops', title: '高级运维', description: '凭证有效期限、列表分页上限与邮件投递服务', legacyGroup: '分页限制' },
]

export type ConfigFieldType = 'integer' | 'switch' | 'select' | 'percentage'

export interface ConfigItemMeta {
  key: AdminSystemConfigKey
  group: ConfigGroupId
  type: ConfigFieldType
  label: string
  description: string
  unit?: string
  min?: number
  max?: number
  options?: Array<{ value: number; label: string }>
}

export const CONFIG_METAS: Record<AdminSystemConfigKey, ConfigItemMeta> = {
  // a. 注册与邀请 (10 项)
  registrationEnabled: {
    key: 'registrationEnabled',
    group: 'registration',
    type: 'switch',
    label: '允许新用户注册',
    description: '关闭仅阻止新账号自助注册，现有账号仍可登录；不等于全站停用。',
  },
  registrationInviteOnly: {
    key: 'registrationInviteOnly',
    group: 'registration',
    type: 'switch',
    label: '注册必须使用邀请码',
    description: '开启须有效邀请码；关闭后邀请码可选，不是停用所有邀请码。',
  },
  emailVerificationRequiredForValue: {
    key: 'emailVerificationRequiredForValue',
    group: 'registration',
    type: 'switch',
    label: '交易与积分操作前须验证邮箱',
    description: '开启后未验证邮箱不能下单、签到等价值操作；不是禁止浏览或登录。',
  },
  referralInviterMinAgeDays: {
    key: 'referralInviterMinAgeDays',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 365,
    unit: '天',
    label: '邀请人账号注册满多少天可建立邀请关系',
    description: '0 不要求额外账号年龄，其他资格规则仍保留；不要混同发码会员门槛。',
  },
  referralDailyQualifiedLimit: {
    key: 'referralDailyQualifiedLimit',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 100,
    unit: '人',
    label: '每位邀请人每日合格人数上限',
    description: '北京时间自然日；0 暂停后续邀请资格，不是无限；非零时不得大于累计上限。',
  },
  referralLifetimeQualifiedLimit: {
    key: 'referralLifetimeQualifiedLimit',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 10000,
    unit: '人',
    label: '每位邀请人累计合格人数上限',
    description: '0 暂停后续邀请资格，不是清除既有记录；若要将两项均设 0，先将每日上限设为 0。',
  },
  inviteMinTierRank: {
    key: 'inviteMinTierRank',
    group: 'registration',
    type: 'select',
    label: '普通用户发码最低会员等级',
    description: '限制普通用户生成邀请码的会员等级门槛。',
    options: [
      { value: 0, label: '不限（青铜会员及以上）' },
      { value: 1, label: '银卡会员及以上' },
      { value: 2, label: '金卡会员及以上' },
      { value: 3, label: '仅限铂金会员' },
    ],
  },
  inviteQuotaUserMonthly: {
    key: 'inviteQuotaUserMonthly',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 1000,
    unit: '枚',
    label: '普通用户每月可生成邀请码数',
    description: '北京时间自然月；0 暂停普通用户发码；生成即占名额，过期不返还。',
  },
  inviteQuotaMerchantMonthly: {
    key: 'inviteQuotaMerchantMonthly',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 1000,
    unit: '枚',
    label: '商家每月可生成邀请码数',
    description: '北京时间自然月；0 暂停商家发码；同样不是每月“成功邀请人数”。',
  },
  inviteCodeTtlDays: {
    key: 'inviteCodeTtlDays',
    group: 'registration',
    type: 'integer',
    min: 1,
    max: 90,
    unit: '天',
    label: '邀请码有效期',
    description: '自生成起 1～90 天；过期未使用也不返还当月名额。',
  },

  // b. 基础奖励 (4 项)
  registerReward: {
    key: 'registerReward',
    group: 'rewards',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '新用户注册基础奖励',
    description: '0 为不发放该项积分；邮箱验证、冷静期等资格规则仍生效，不承诺注册即到账。',
  },
  checkinReward: {
    key: 'checkinReward',
    group: 'rewards',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '每日签到基础奖励',
    description: '最终值可能叠加会员额外加成；0 不等于关闭签到功能。',
  },
  inviteReward: {
    key: 'inviteReward',
    group: 'rewards',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '邀请新用户基础奖励',
    description: '奖励给符合条件的邀请人，可能叠加会员加成并进入待发流程；不是被邀请人奖励。',
  },
  growthRewardHoldDays: {
    key: 'growthRewardHoldDays',
    group: 'rewards',
    type: 'integer',
    min: 0,
    max: 30,
    unit: '天',
    label: '注册与邀请奖励冷静期',
    description: '邮箱验证后等待 0～30 天；0 即时发放、风险更高；不得承诺重算已创建奖励。',
  },

  // c. 会员等级 (6 项)
  memberTierSilverThreshold: {
    key: 'memberTierSilverThreshold',
    group: 'memberTier',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '银卡累计获得积分门槛',
    description: '与金卡、铂金严格递增；必须是用户流水累计获得积分，不是余额、消费额或充值金额。',
  },
  memberTierGoldThreshold: {
    key: 'memberTierGoldThreshold',
    group: 'memberTier',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '金卡累计获得积分门槛',
    description: '银卡 < 金卡 < 铂金，保存任何一项都不能破坏严格递增关系。',
  },
  memberTierPlatinumThreshold: {
    key: 'memberTierPlatinumThreshold',
    group: 'memberTier',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '铂金累计获得积分门槛',
    description: '铂金门槛必须大于金卡门槛；达到该累计积分即自动晋级。',
  },
  memberTierSilverBonusBps: {
    key: 'memberTierSilverBonusBps',
    group: 'memberTier',
    type: 'percentage',
    min: 0,
    max: 100,
    unit: '%',
    label: '银卡签到／邀请额外加成',
    description: '支持最多两位小数（如 5% 保存为 500 基点）；0 为无额外加成。按 floor(基础奖励 × 百分比) 额外发放。',
  },
  memberTierGoldBonusBps: {
    key: 'memberTierGoldBonusBps',
    group: 'memberTier',
    type: 'percentage',
    min: 0,
    max: 100,
    unit: '%',
    label: '金卡签到／邀请额外加成',
    description: '支持最多两位小数；0 为无额外加成。',
  },
  memberTierPlatinumBonusBps: {
    key: 'memberTierPlatinumBonusBps',
    group: 'memberTier',
    type: 'percentage',
    min: 0,
    max: 100,
    unit: '%',
    label: '铂金签到／邀请额外加成',
    description: '支持最多两位小数；0 为无额外加成。',
  },

  // d. 交易与交付 (9 项)
  checkoutVerifyAmountThreshold: {
    key: 'checkoutVerifyAmountThreshold',
    group: 'trade',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '单笔订单需密码确认的积分门槛',
    description: '本单积分达到门槛时要求登录密码；0 关闭此单笔维度，不是关闭所有鉴权。',
  },
  checkoutVerifyDailyThreshold: {
    key: 'checkoutVerifyDailyThreshold',
    group: 'trade',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '当日累计订单需密码确认的积分门槛',
    description: '当日已成交累计加本单达到门槛时触发；0 关闭此累计维度。',
  },
  fileUrlTtlSeconds: {
    key: 'fileUrlTtlSeconds',
    group: 'trade',
    type: 'integer',
    min: 30,
    max: 3600,
    unit: '秒',
    label: '单次下载链接有效期',
    description: '30～3600 秒；从签发起算，已签发链接在到期前不可即时撤销。',
  },
  fileAccessWindowDays: {
    key: 'fileAccessWindowDays',
    group: 'trade',
    type: 'integer',
    min: 0,
    max: 365,
    unit: '天',
    label: '交付后允许获取下载链接的期限',
    description: '从订单交付时刻起算；0 为不限窗口，仍需权限和其他访问条件。',
  },
  deliveryFileMaxMb: {
    key: 'deliveryFileMaxMb',
    group: 'trade',
    type: 'integer',
    min: 1,
    max: 100,
    unit: 'MB',
    label: '单个交付文件大小上限',
    description: '1～100 MB；限制平台上传文件体积。',
  },
  autoCloseDays: {
    key: 'autoCloseDays',
    group: 'trade',
    type: 'integer',
    min: 1,
    max: 90,
    unit: '天',
    label: '交付后自动确认并结算的等待天数',
    description: '1～90 天；买家未主动确认时适用，修改对新一轮巡检生效；不是待支付订单有效期。',
  },
  fulfillmentSlaDays: {
    key: 'fulfillmentSlaDays',
    group: 'trade',
    type: 'integer',
    min: 1,
    max: 90,
    unit: '天',
    label: '人工服务履约期限',
    description: '1～90 天，从下单起计算；仅影响新订单，不追改既有订单期限。',
  },
  subscriptionRemindDays: {
    key: 'subscriptionRemindDays',
    group: 'trade',
    type: 'integer',
    min: 0,
    max: 30,
    unit: '天',
    label: '订阅到期前提前提醒天数',
    description: '0～30 天；0 仅关闭提前提醒，仍保留到期提醒。',
  },
  autoProvisionMaxAttempts: {
    key: 'autoProvisionMaxAttempts',
    group: 'trade',
    type: 'integer',
    min: 0,
    max: 5,
    unit: '次',
    label: '自动开通最多尝试次数',
    description: '0～5 次；0 暂停外呼、只建任务不推进状态；恢复后已有任务按既有退避继续，不是无限重试。',
  },

  // e. 库存提醒 (2 项)
  lowStockThreshold: {
    key: 'lowStockThreshold',
    group: 'inventory',
    type: 'integer',
    min: 0,
    unit: '条',
    label: '即时库存低库存提醒阈值',
    description: '可用库存 ≤ 阈值时进入低位；0 不是关闭告警，不把库存条目泛称人民币“金额”。',
  },
  lowStockNotifyCooldownHours: {
    key: 'lowStockNotifyCooldownHours',
    group: 'inventory',
    type: 'integer',
    min: 0,
    max: 720,
    unit: '小时',
    label: '持续低库存邮件重发间隔',
    description: '0～720 小时；0 进入低位只发一次、不持续重发，不是完全停发邮件。',
  },

  // f. 商品运营 (8 项)
  hotWindowDays: {
    key: 'hotWindowDays',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 365,
    unit: '天',
    label: '自然热卖销量统计窗口',
    description: '1～365 天；不改净成交等既有统计口径。',
  },
  hotMinSales: {
    key: 'hotMinSales',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 100000,
    unit: '单',
    label: '进入自然热卖的最低成交量',
    description: '1～100000 单；不是商品库存阈值。',
  },
  hotTopPercent: {
    key: 'hotTopPercent',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 100,
    unit: '%',
    label: '分类内入选自然热卖的前百分比',
    description: '1～100；前 20% 不是“销量提高 20%”。',
  },
  hotRecomputeMinutes: {
    key: 'hotRecomputeMinutes',
    group: 'merchandising',
    type: 'integer',
    min: 10,
    max: 1440,
    unit: '分钟',
    label: '自然热卖自动重算间隔',
    description: '10～1440 分钟；不同于统计窗口天数。',
  },
  hotRunTimeoutMinutes: {
    key: 'hotRunTimeoutMinutes',
    group: 'merchandising',
    type: 'integer',
    min: 10,
    max: 1440,
    unit: '分钟',
    label: '计算任务超时回收时间',
    description: '10～1440 分钟；作为本组高级参数，不主显“排名 run”。',
  },
  partnerSpendWindowDays: {
    key: 'partnerSpendWindowDays',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 365,
    unit: '天',
    label: '合作伙伴资格消费统计窗口',
    description: '1～365 天；用于自动授予资格的净推广消费统计。',
  },
  partnerMinPromotionPoints: {
    key: 'partnerMinPromotionPoints',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 2000000000,
    unit: '积分',
    label: '自动获得合作伙伴权益的净推广消费门槛',
    description: '1～2,000,000,000 积分；不是充值额、商品销售额或当前积分余额。',
  },
  partnerEntitlementDays: {
    key: 'partnerEntitlementDays',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 365,
    unit: '天',
    label: '自动授予合作伙伴权益的有效天数',
    description: '1～365 天；与消费统计窗口区分，不把手动权益期限一并改写。',
  },

  // g. 高级运维 (3 项)
  refreshTokenMaxAgeDays: {
    key: 'refreshTokenMaxAgeDays',
    group: 'ops',
    type: 'integer',
    min: 0,
    unit: '天',
    label: '登录续期凭证有效期',
    description: '对新签发的续期凭证生效；0 沿现有逻辑使用部署配置值，不是永不过期或立即踢人；原 Refresh Token 术语在详情。',
  },
  defaultPageSize: {
    key: 'defaultPageSize',
    group: 'ops',
    type: 'integer',
    min: 0,
    unit: '条',
    label: '支持此规则的接口默认每页条数',
    description: '未显式请求页大小时使用；正值建议不大于上限。当前管理／商家列表读取处 0 回用内置默认值，不代表不分页。',
  },
  maxPageSize: {
    key: 'maxPageSize',
    group: 'ops',
    type: 'integer',
    min: 0,
    unit: '条',
    label: '支持此规则的接口每页条数上限',
    description: '当前管理／商家列表会限制请求大小，0 回用内置上限；不是无限。不要承诺所有固定 20 条的页面立即跟随变化。',
  },
}

/** 整数基点 (0..10000) 转换为展示百分比字符串 (0..100，最多两位小数) */
export function bpsToPercentString(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0'
  return (bps / 100).toString()
}

/** 百分比字符串解析为整数基点，校验范围与格式 */
export function percentStringToBps(raw: string): { value?: number; error?: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { error: '请输入百分比加成' }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { error: '百分比最多支持两位小数' }
  }
  const n = parseFloat(trimmed)
  if (n < 0 || n > 100) {
    return { error: '百分比必须在 0% ~ 100% 之间' }
  }
  return { value: Math.round(n * 100) }
}
