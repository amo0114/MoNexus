import api from './client'

export type AdminSystemConfigKey =
  // 注册与邀请 (10)
  | 'registrationEnabled'
  | 'registrationInviteOnly'
  | 'emailVerificationRequiredForValue'
  | 'referralInviterMinAgeDays'
  | 'referralDailyQualifiedLimit'
  | 'referralLifetimeQualifiedLimit'
  | 'inviteMinTierRank'
  | 'inviteQuotaUserMonthly'
  | 'inviteQuotaMerchantMonthly'
  | 'inviteCodeTtlDays'
  // 基础奖励 (4)
  | 'registerReward'
  | 'checkinReward'
  | 'inviteReward'
  | 'growthRewardHoldDays'
  // 会员等级 (6)
  | 'memberTierSilverThreshold'
  | 'memberTierGoldThreshold'
  | 'memberTierPlatinumThreshold'
  | 'memberTierSilverBonusBps'
  | 'memberTierGoldBonusBps'
  | 'memberTierPlatinumBonusBps'
  // 交易与交付 (9)
  | 'checkoutVerifyAmountThreshold'
  | 'checkoutVerifyDailyThreshold'
  | 'fileUrlTtlSeconds'
  | 'fileAccessWindowDays'
  | 'deliveryFileMaxMb'
  | 'autoCloseDays'
  | 'fulfillmentSlaDays'
  | 'subscriptionRemindDays'
  | 'autoProvisionMaxAttempts'
  // 库存提醒 (2)
  | 'lowStockThreshold'
  | 'lowStockNotifyCooldownHours'
  // 商品运营 (8)
  | 'hotWindowDays'
  | 'hotMinSales'
  | 'hotTopPercent'
  | 'hotRecomputeMinutes'
  | 'hotRunTimeoutMinutes'
  | 'partnerSpendWindowDays'
  | 'partnerMinPromotionPoints'
  | 'partnerEntitlementDays'
  // 高级运维 (3)
  | 'refreshTokenMaxAgeDays'
  | 'defaultPageSize'
  | 'maxPageSize'

export interface AdminSystemConfig {
  key: AdminSystemConfigKey
  value: number
  defaultValue: number
  /** 中文配置项说明，配置页主标签 */
  description: string
  /** 中文分组名：奖励发放 / 安全 / 分页限制 / 库存 / 会员等级 */
  group: string
  /** 可选单位标注，如 积分 / 天 / 条/页 */
  unit: string | null
  /** 可选填写提示，如万分比换算说明 */
  hint: string | null
  /** 服务端权威取值区间（写入侧同表校验）；旧后端可能缺省。 */
  min?: number
  max?: number
  updatedAt: string | null
  updatedBy: number | null
}

export async function getAdminConfig(): Promise<AdminSystemConfig[]> {
  const { data } = await api.get<AdminSystemConfig[]>('/admin/config')
  return data
}

export async function updateAdminConfig(
  key: AdminSystemConfigKey,
  value: number,
): Promise<AdminSystemConfig> {
  const { data } = await api.put<AdminSystemConfig>(`/admin/config/${key}`, { value })
  return data
}
