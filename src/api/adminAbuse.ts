import api from './client'

export type AdminAbuseWindow = '1h' | '24h'
export type AdminAbuseReferralState = 'legacy' | 'pending_verification' | 'qualified' | 'quota_exhausted' | 'voided'
export type AdminAbuseRewardState = 'pending_verification' | 'held' | 'granted' | 'voided'

export interface AdminAbuseOverview {
  window: AdminAbuseWindow
  since: string
  registrations: { attempts: number; accepted: number; rejected: number }
  challengeFailures: number
  verificationEmail: { sent: number; throttled: number }
  unverifiedUsers: number
  referrals: {
    pendingVerification: number
    qualified: number
    quotaExhausted: number
    voided: number
  }
  rewards: {
    pendingVerification: number
    held: number
    granted: number
    voided: number
  }
}

export interface AdminAbuseReferral {
  id: number
  status: AdminAbuseReferralState
  qualifiedAt: string | null
  voidedAt: string | null
  qualificationDay: string | null
  createdAt: string
  inviter: { id: number; email: string; referralSuspended: boolean }
  invitee: { id: number; email: string; emailVerified: string | null }
  reward: {
    id: number
    amount: number
    state: AdminAbuseRewardState
    availableAt: string | null
    grantedAt: string | null
    voidedAt: string | null
    voidReason: string | null
  } | null
}

export interface AdminAbuseReward {
  id: number
  kind: 'registration' | 'referral'
  amount: number
  state: AdminAbuseRewardState
  availableAt: string | null
  grantedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  createdAt: string
  recipient: { id: number; email: string }
  inviteRelation: {
    id: number
    status: AdminAbuseReferralState
    inviter: { id: number; email: string; referralSuspended: boolean }
    invitee: { id: number; email: string }
  } | null
}

export interface AdminAbusePage<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

export async function getAdminAbuseOverview(window: AdminAbuseWindow) {
  const { data } = await api.get<AdminAbuseOverview>('/admin/abuse/overview', { params: { window } })
  return data
}

export async function listAdminAbuseReferrals(input: {
  state?: AdminAbuseReferralState
  q?: string
  page: number
  pageSize: number
}) {
  const { data } = await api.get<AdminAbusePage<AdminAbuseReferral>>('/admin/abuse/referrals', { params: input })
  return data
}

export async function listAdminAbuseRewards(input: {
  state?: AdminAbuseRewardState
  userId?: number
  page: number
  pageSize: number
}) {
  const { data } = await api.get<AdminAbusePage<AdminAbuseReward>>('/admin/abuse/rewards', { params: input })
  return data
}

export async function setAdminReferralSuspension(
  userId: number,
  input: { suspended: boolean; caseRef: string },
) {
  const { data } = await api.put<{ userId: number; suspended: boolean; voidedRewards: number }>(
    `/admin/abuse/users/${userId}/referral-suspension`,
    input,
  )
  return data
}

export async function voidAdminAbuseReward(rewardId: number, caseRef: string) {
  const { data } = await api.post<{
    id: number
    kind: AdminAbuseReward['kind']
    amount: number
    state: 'voided'
    caseRef: string
  }>(`/admin/abuse/rewards/${rewardId}/void`, { caseRef })
  return data
}
