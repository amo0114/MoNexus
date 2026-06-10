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
