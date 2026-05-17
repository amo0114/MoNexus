import api from './client'
import { ConfigRegistry } from '../types/config'

export interface MemberTierMeta {
  value: 'bronze' | 'silver' | 'gold' | 'platinum'
  label: string
  tone: 'neutral' | 'info' | 'warning' | 'success'
}

export interface RegistryResponse extends ConfigRegistry {
  memberTiers: MemberTierMeta[]
  memberTierThresholds: { silver: number; gold: number; platinum: number }
  memberTierBonusBps: { bronze: 0; silver: number; gold: number; platinum: number }
}

let registryCache: RegistryResponse | null = null
let registryPromise: Promise<RegistryResponse> | null = null

export async function getConfigRegistry(): Promise<RegistryResponse> {
  if (registryCache) {
    return registryCache
  }
  if (registryPromise) {
    return registryPromise
  }

  registryPromise = api.get<RegistryResponse>('/config/registry')
    .then(res => {
      registryCache = res.data
      registryPromise = null
      return res.data
    })
    .catch(err => {
      registryPromise = null
      throw err
    })

  return registryPromise
}
