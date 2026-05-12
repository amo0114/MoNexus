import api from './client'

export type AdminSystemConfigKey =
  | 'registerReward'
  | 'checkinReward'
  | 'inviteReward'
  | 'refreshTokenMaxAgeDays'

export interface AdminSystemConfig {
  key: AdminSystemConfigKey
  value: number
  defaultValue: number
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
