import api from './client'

export type AdminSystemConfigKey =
  | 'registerReward'
  | 'checkinReward'
  | 'inviteReward'
  | 'refreshTokenMaxAgeDays'
  | 'defaultPageSize'
  | 'maxPageSize'
  | 'lowStockThreshold'
  | 'memberTierSilverThreshold'
  | 'memberTierGoldThreshold'
  | 'memberTierPlatinumThreshold'
  | 'memberTierSilverBonusBps'
  | 'memberTierGoldBonusBps'
  | 'memberTierPlatinumBonusBps'
  | 'checkoutVerifyAmountThreshold'
  | 'checkoutVerifyDailyThreshold'
  // P5 受控文件交付
  | 'fileUrlTtlSeconds'
  | 'fileAccessWindowDays'
  | 'deliveryFileMaxMb'
  // P5.5 低库存告警冷却
  | 'lowStockNotifyCooldownHours'
  // P6a 订单计时 / 订阅提醒
  | 'autoCloseDays'
  | 'fulfillmentSlaDays'
  | 'subscriptionRemindDays'
  // P7b 自动开通外呼上限
  | 'autoProvisionMaxAttempts'
  // SPEC-OPS-REGMAIL-001 公开注册总开关（仅 0/1，由 RegistrationControlPanel 渲染）
  | 'registrationEnabled'

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
