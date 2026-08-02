import api from './client'

export type MemberTier = 'bronze' | 'silver' | 'gold' | 'platinum'

export type InviteEligibility = {
  eligible: boolean
  tier: MemberTier
  tierRank: number
  canIssue: boolean
  reason?: string
  quotaStatus: {
    used: number
    limit: number
    remaining: number
  }
}

export type InviteCodeRecord = {
  id: number
  code: string
  issuedBy: number
  claimedBy: number | null
  createdAt: string
  expiresAt: string
  claimedAt: string | null
  expired: boolean
  revoked: boolean
}

export type MyInvitesResponse = {
  eligibility: InviteEligibility
  codes: InviteCodeRecord[]
}

export type CreateInviteResponse = {
  code: InviteCodeRecord
  eligibility: InviteEligibility
}

export async function getMyInvites(): Promise<MyInvitesResponse> {
  const { data } = await api.get<MyInvitesResponse>('/invites/me')
  return data
}

export async function createInviteCode(): Promise<CreateInviteResponse> {
  const { data } = await api.post<CreateInviteResponse>('/invites')
  return data
}
