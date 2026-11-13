import { useEffect } from 'react'
import { create } from 'zustand'
import { getAdminCapabilities } from '../api/governance'
import { getApiErrorMessage } from '../api/error'
import { useAuthStore } from './authStore'
import { isNotFoundError } from '../utils/governance'
import {
  GOVERNANCE_CONTRACT_VERSION,
  type AdminPermission,
  type GVCapabilities,
  type GovernanceFeature,
} from '../types/governance'

/**
 * - unavailable: the backend predates governance-v1 (no endpoint / other contract).
 *   New features stay off; legacy panels keep their old behavior. Never assume super.
 */
export type CapabilitiesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; capabilities: GVCapabilities }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

interface CapabilitiesStore {
  identity: string | null
  state: CapabilitiesState
  load: (identity: string, force?: boolean) => Promise<void>
}

let inflight: { identity: string; promise: Promise<void> } | null = null

export const useCapabilitiesStore = create<CapabilitiesStore>((set, get) => ({
  identity: null,
  state: { status: 'idle' },
  load: async (identity, force = false) => {
    const current = get()
    if (!force && current.identity === identity && current.state.status !== 'idle' && current.state.status !== 'error') return
    if (!force && inflight?.identity === identity) return inflight.promise
    set({ identity, state: { status: 'loading' } })
    const promise = (async () => {
      let next: CapabilitiesState
      try {
        const capabilities = await getAdminCapabilities()
        next = capabilities?.contractVersion === GOVERNANCE_CONTRACT_VERSION
          ? { status: 'ready', capabilities }
          : { status: 'unavailable' }
      } catch (error) {
        next = isNotFoundError(error)
          ? { status: 'unavailable' }
          : { status: 'error', message: getApiErrorMessage(error, '无法读取后台权限') }
      }
      // A response for a previous identity must not land on the current admin.
      if (get().identity === identity) set({ state: next })
    })()
    inflight = { identity, promise }
    try {
      await promise
    } finally {
      if (inflight?.promise === promise) inflight = null
    }
  },
}))

function useIdentityKey(): string | null {
  return useAuthStore((s) => (s.user?.role === 'admin' ? `${s.user.id}:${s.sessionId ?? ''}:${s.authEpoch}` : null))
}

export interface AdminCapabilities {
  state: CapabilitiesState
  /** True only when the governance-v1 backend is present. */
  governed: boolean
  can: (permission: AdminPermission) => boolean
  feature: (feature: GovernanceFeature) => boolean
  /** Feature deployed and the admin holds every listed permission. */
  allows: (feature: GovernanceFeature, ...permissions: AdminPermission[]) => boolean
  limits: GVCapabilities['limits'] | null
  reload: () => void
}

export function useAdminCapabilities(): AdminCapabilities {
  const identity = useIdentityKey()
  const storeIdentity = useCapabilitiesStore((s) => s.identity)
  const rawState = useCapabilitiesStore((s) => s.state)
  const load = useCapabilitiesStore((s) => s.load)

  useEffect(() => {
    if (identity) void load(identity)
  }, [identity, load])

  const state: CapabilitiesState = identity && storeIdentity === identity ? rawState : { status: 'idle' }
  const capabilities = state.status === 'ready' ? state.capabilities : null
  const can = (permission: AdminPermission) => Boolean(capabilities?.permissions.includes(permission))
  const feature = (name: GovernanceFeature) => Boolean(capabilities?.features[name])
  return {
    state,
    governed: capabilities !== null,
    can,
    feature,
    allows: (name, ...permissions) => feature(name) && permissions.every(can),
    limits: capabilities?.limits ?? null,
    reload: () => {
      if (identity) void load(identity, true)
    },
  }
}
