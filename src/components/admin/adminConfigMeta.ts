import { AdminSystemConfigKey } from '../../api/adminConfig'

export type ConfigGroupId =
  | 'registration' // 注册与邀请 (10)
  | 'rewards' // 基础奖励 (4)
  | 'memberTier' // 会员等级 (6)
  | 'trade' // 交易与交付 (9)
  | 'inventory' // 库存提醒 (2)
  | 'merchandising' // 商品运营 (8)
  | 'ops' // 高级运维 (3)
  | 'system' // 系统信息 (build artifact)

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
  { id: 'system', title: '系统信息', description: '当前 API 镜像的运行版本与构建元数据，仅管理员可见' },
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
    description: '控制全站新用户注册通道。关闭后仅阻止新账号注册，已有账号仍可正常登录。',
  },
  registrationInviteOnly: {
    key: 'registrationInviteOnly',
    group: 'registration',
    type: 'switch',
    label: '注册必须使用邀请码',
    description: '开启后新用户注册必须填写有效邀请码；关闭后邀请码为选填项。',
  },
  emailVerificationRequiredForValue: {
    key: 'emailVerificationRequiredForValue',
    group: 'registration',
    type: 'switch',
    label: '交易与积分操作前须验证邮箱',
    description: '开启后用户须完成邮箱验证方可进行下单、签到等涉及积分与资金的操作。',
  },
  referralInviterMinAgeDays: {
    key: 'referralInviterMinAgeDays',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 365,
    unit: '天',
    label: '邀请人账号注册满多少天可建立邀请关系',
    description: '设置邀请人建立有效邀请关系的最低账号注册天数；设为 0 时不作限制。',
  },
  referralDailyQualifiedLimit: {
    key: 'referralDailyQualifiedLimit',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 100,
    unit: '人',
    label: '每位邀请人每日合格人数上限',
    description: '单日（北京时间自然日）最多计入的合格被邀请人数；设为 0 时暂停计入新合格人数；非零时不可大于累计上限。',
  },
  referralLifetimeQualifiedLimit: {
    key: 'referralLifetimeQualifiedLimit',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 10000,
    unit: '人',
    label: '每位邀请人累计合格人数上限',
    description: '每位邀请人累计最多计入的合格被邀请人数；设为 0 时暂停计入新合格人数（保留历史记录）。若需将两项均设为 0，请先保存每日上限为 0。',
  },
  inviteMinTierRank: {
    key: 'inviteMinTierRank',
    group: 'registration',
    type: 'select',
    label: '普通用户发码最低会员等级',
    description: '普通用户生成邀请码所需的最低会员等级门槛。',
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
    description: '普通用户单月（自然月）可生成的邀请码总额度；设为 0 时暂停生成。生成即占用名额，过期不退还。',
  },
  inviteQuotaMerchantMonthly: {
    key: 'inviteQuotaMerchantMonthly',
    group: 'registration',
    type: 'integer',
    min: 0,
    max: 1000,
    unit: '枚',
    label: '商家每月可生成邀请码数',
    description: '商家单月（自然月）可生成的邀请码总额度；设为 0 时暂停生成。生成即占用名额，过期不退还。',
  },
  inviteCodeTtlDays: {
    key: 'inviteCodeTtlDays',
    group: 'registration',
    type: 'integer',
    min: 1,
    max: 90,
    unit: '天',
    label: '邀请码有效期',
    description: '新生成邀请码的有效天数（1～90 天），逾期自动失效。',
  },

  // b. 基础奖励 (4 项)
  registerReward: {
    key: 'registerReward',
    group: 'rewards',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '新用户注册基础奖励',
    description: '新用户注册成功后发放的基础积分奖励；设为 0 时不发放。仍须符合邮箱验证与冷静期规则。',
  },
  checkinReward: {
    key: 'checkinReward',
    group: 'rewards',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '每日签到基础奖励',
    description: '用户每日签到发放的基础积分奖励；设为 0 时不发放基础积分（高等级会员可能叠加额外加成）。',
  },
  inviteReward: {
    key: 'inviteReward',
    group: 'rewards',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '邀请新用户基础奖励',
    description: '成功邀请新用户后发放给邀请人的基础积分；高等级会员可叠加额外加成。',
  },
  growthRewardHoldDays: {
    key: 'growthRewardHoldDays',
    group: 'rewards',
    type: 'integer',
    min: 0,
    max: 30,
    unit: '天',
    label: '注册与邀请奖励冷静期',
    description: '完成邮箱验证后奖励冻结等待到账的天数（0～30 天）；设为 0 时即时到账。仅对新发放奖励生效。',
  },

  // c. 会员等级 (6 项)
  memberTierSilverThreshold: {
    key: 'memberTierSilverThreshold',
    group: 'memberTier',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '银卡累计获得积分门槛',
    description: '晋升银卡会员所需的流水累计获得积分；需满足 银卡 < 金卡 < 铂金 严格递增关系。',
  },
  memberTierGoldThreshold: {
    key: 'memberTierGoldThreshold',
    group: 'memberTier',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '金卡累计获得积分门槛',
    description: '晋升金卡会员所需的流水累计获得积分；需满足 银卡 < 金卡 < 铂金 严格递增关系。',
  },
  memberTierPlatinumThreshold: {
    key: 'memberTierPlatinumThreshold',
    group: 'memberTier',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '铂金累计获得积分门槛',
    description: '晋升铂金会员所需的流水累计获得积分；需满足大于金卡门槛。',
  },
  memberTierSilverBonusBps: {
    key: 'memberTierSilverBonusBps',
    group: 'memberTier',
    type: 'percentage',
    min: 0,
    max: 100,
    unit: '%',
    label: '银卡签到／邀请额外加成',
    description: '基础奖励乘以加成比例，结果向下取整；支持最多两位小数；设为 0 时无额外加成。',
  },
  memberTierGoldBonusBps: {
    key: 'memberTierGoldBonusBps',
    group: 'memberTier',
    type: 'percentage',
    min: 0,
    max: 100,
    unit: '%',
    label: '金卡签到／邀请额外加成',
    description: '基础奖励乘以加成比例，结果向下取整；支持最多两位小数；设为 0 时无额外加成。',
  },
  memberTierPlatinumBonusBps: {
    key: 'memberTierPlatinumBonusBps',
    group: 'memberTier',
    type: 'percentage',
    min: 0,
    max: 100,
    unit: '%',
    label: '铂金签到／邀请额外加成',
    description: '基础奖励乘以加成比例，结果向下取整；支持最多两位小数；设为 0 时无额外加成。',
  },

  // d. 交易与交付 (9 项)
  checkoutVerifyAmountThreshold: {
    key: 'checkoutVerifyAmountThreshold',
    group: 'trade',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '单笔订单需密码确认的积分门槛',
    description: '单笔订单积分金额达到该门槛时要求输入登录密码二次确认；设为 0 时不开启单笔门槛限制。',
  },
  checkoutVerifyDailyThreshold: {
    key: 'checkoutVerifyDailyThreshold',
    group: 'trade',
    type: 'integer',
    min: 0,
    unit: '积分',
    label: '当日累计订单需密码确认的积分门槛',
    description: '当日累计消费积分达到该门槛时要求输入登录密码二次确认；设为 0 时不开启当日累计门槛限制。',
  },
  fileUrlTtlSeconds: {
    key: 'fileUrlTtlSeconds',
    group: 'trade',
    type: 'integer',
    min: 30,
    max: 3600,
    unit: '秒',
    label: '单次下载链接有效期',
    description: '生成的文件下载链接有效时限（30～3600 秒），超时需重新获取。',
  },
  fileAccessWindowDays: {
    key: 'fileAccessWindowDays',
    group: 'trade',
    type: 'integer',
    min: 0,
    max: 365,
    unit: '天',
    label: '交付后允许获取下载链接的期限',
    description: '订单交付后允许买家获取下载链接的天数；设为 0 时表示不限访问窗口。',
  },
  deliveryFileMaxMb: {
    key: 'deliveryFileMaxMb',
    group: 'trade',
    type: 'integer',
    min: 1,
    max: 100,
    unit: 'MB',
    label: '单个交付文件大小上限',
    description: '商家交付商品时允许上传的单个文件体积上限（1～100 MB）。',
  },
  autoCloseDays: {
    key: 'autoCloseDays',
    group: 'trade',
    type: 'integer',
    min: 1,
    max: 90,
    unit: '天',
    label: '交付后自动确认并结算的等待天数',
    description: '交付后买家未主动确认收货时的超时自动结算天数（1～90 天）；修改对下一轮巡检生效。',
  },
  fulfillmentSlaDays: {
    key: 'fulfillmentSlaDays',
    group: 'trade',
    type: 'integer',
    min: 1,
    max: 90,
    unit: '天',
    label: '人工服务履约期限',
    description: '人工服务类订单从下单起算的履约时限（1～90 天）；仅对新创建订单生效。',
  },
  subscriptionRemindDays: {
    key: 'subscriptionRemindDays',
    group: 'trade',
    type: 'integer',
    min: 0,
    max: 30,
    unit: '天',
    label: '订阅到期前提前提醒天数',
    description: '订阅商品到期前发送续费提醒的提前天数；设为 0 时仅在到期当天提醒。',
  },
  autoProvisionMaxAttempts: {
    key: 'autoProvisionMaxAttempts',
    group: 'trade',
    type: 'integer',
    min: 0,
    max: 5,
    unit: '次',
    label: '自动开通最多尝试次数',
    description: '每个自动开通任务最多尝试的总次数，包含首次执行。设为 0 时暂停自动外呼，不重置已有任务状态。',
  },

  // e. 库存提醒 (2 项)
  lowStockThreshold: {
    key: 'lowStockThreshold',
    group: 'inventory',
    type: 'integer',
    min: 0,
    unit: '条',
    label: '即时库存低库存提醒阈值',
    description: '卡密可用库存条目数低于或等于该阈值时触发低库存告警；设为 0 时仅在完全无库存时预警。',
  },
  lowStockNotifyCooldownHours: {
    key: 'lowStockNotifyCooldownHours',
    group: 'inventory',
    type: 'integer',
    min: 0,
    max: 720,
    unit: '小时',
    label: '持续低库存邮件重发间隔',
    description: '商品持续处于低库存状态时重新发送预警邮件的冷却时间；设为 0 时每次低库存仅通知一次。',
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
    description: '统计商品成交销量的回溯天数窗口（1～365 天）。',
  },
  hotMinSales: {
    key: 'hotMinSales',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 100000,
    unit: '单',
    label: '进入自然热卖的最低成交量',
    description: '商品入选自然热卖榜单所需的最低成交订单数（1～100,000 单）。',
  },
  hotTopPercent: {
    key: 'hotTopPercent',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 100,
    unit: '%',
    label: '分类内入选自然热卖的前百分比',
    description: '同一分类内按销量排名前百分之几的商品进入热卖榜（1%～100%）。',
  },
  hotRecomputeMinutes: {
    key: 'hotRecomputeMinutes',
    group: 'merchandising',
    type: 'integer',
    min: 10,
    max: 1440,
    unit: '分钟',
    label: '自然热卖自动重算间隔',
    description: '系统定时重新计算商品热卖排名的执行周期（10～1440 分钟）。',
  },
  hotRunTimeoutMinutes: {
    key: 'hotRunTimeoutMinutes',
    group: 'merchandising',
    type: 'integer',
    min: 10,
    max: 1440,
    unit: '分钟',
    label: '计算任务超时回收时间',
    description: '运行超过该时限的计算任务将被标记为失败；后续计算按现有调度执行。',
  },
  partnerSpendWindowDays: {
    key: 'partnerSpendWindowDays',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 365,
    unit: '天',
    label: '合作伙伴资格消费统计窗口',
    description: '用于自动授予合作伙伴资格的推广消费统计回溯天数（1～365 天）。',
  },
  partnerMinPromotionPoints: {
    key: 'partnerMinPromotionPoints',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 2000000000,
    unit: '积分',
    label: '自动获得合作伙伴权益的净推广消费门槛',
    description: '统计窗口内净推广消费达到的积分门槛，达标后系统自动授予权益。',
  },
  partnerEntitlementDays: {
    key: 'partnerEntitlementDays',
    group: 'merchandising',
    type: 'integer',
    min: 1,
    max: 365,
    unit: '天',
    label: '自动授予合作伙伴权益的有效天数',
    description: '系统自动授予的合作伙伴权益有效天数（1～365 天）；不影响管理员手动授予的期限。',
  },

  // g. 高级运维 (3 项)
  refreshTokenMaxAgeDays: {
    key: 'refreshTokenMaxAgeDays',
    group: 'ops',
    type: 'integer',
    min: 0,
    unit: '天',
    label: '登录续期凭证有效期',
    description: '新签发的登录续期凭证（Refresh Token）有效期天数；设为 0 时使用系统环境变量默认配置。',
  },
  defaultPageSize: {
    key: 'defaultPageSize',
    group: 'ops',
    type: 'integer',
    min: 0,
    unit: '条',
    label: '支持此规则的接口默认每页条数',
    description: '请求未显式指定分页大小时的默认条数；设为 0 时回退到接口内置默认值。',
  },
  maxPageSize: {
    key: 'maxPageSize',
    group: 'ops',
    type: 'integer',
    min: 0,
    unit: '条',
    label: '支持此规则的接口每页条数上限',
    description: '请求单次可拉取的最大分页条数限制；设为 0 时回退到接口内置上限。',
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
