import api from './client'

export interface TierResponse {
  tier: 'bronze' | 'silver' | 'gold' | 'platinum'
  label: string
  tone: 'neutral' | 'info' | 'warning' | 'success'
  lifetimeEarnedPoints: number
  bonusBps: number
  thresholds: { silver: number; gold: number; platinum: number }
  nextTier: 'silver' | 'gold' | 'platinum' | null
  pointsToNextTier: number
}

export async function getMemberTier(): Promise<TierResponse> {
  const res = await api.get<TierResponse>('/points/tier')
  return res.data
}
