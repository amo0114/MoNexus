import api from './client'

export type InviteIneligibleReason =
  | 'not_verified'
  | 'account_too_young'
  | 'suspended'
  | 'tier_too_low'
  | 'role_paused'

export type InviteCodeStatus = 'active' | 'used' | 'expired' | 'revoked'

export type InviteQuota = {
  limit: number
  used: number
  remaining: number
  periodKey: string
}

/** Mirrors the public invite module response. */
export type InviteCodeRecord = {
  code: string
  status: InviteCodeStatus
  createdAt: string
  expiresAt: string
  usedAt: string | null
}

export type MyInvitesResponse = {
  eligible: boolean
  reason?: InviteIneligibleReason
  tierRequired?: string
  /** A null quota denotes the administrator's unlimited allowance. */
  quota: InviteQuota | null
  codes: InviteCodeRecord[]
}

export type CreateInviteResponse = InviteCodeRecord

export async function getMyInvites(): Promise<MyInvitesResponse> {
  const { data } = await api.get<MyInvitesResponse>('/invites/me')
  return data
}

export async function createInviteCode(): Promise<CreateInviteResponse> {
  const { data } = await api.post<CreateInviteResponse>('/invites')
  return data
}
