import { useAuthStore } from '../stores/authStore'
import { useCapabilitiesStore } from '../stores/adminCapabilities'
import type { GVCapabilities } from '../types/governance'

const ADMIN = { id: 1, email: 'admin@example.invalid', role: 'admin', status: '正常', points: 0, merchant: null } as const

/** Signed-in admin against a pre-governance backend: legacy tabs, no new features. */
export function signInLegacyAdmin() {
  useAuthStore.setState({ user: { ...ADMIN }, sessionId: 's', authEpoch: 1 })
  useCapabilitiesStore.setState({ identity: '1:s:1', state: { status: 'unavailable' } })
}

/** Signed-in admin against a governance-v1 backend with the given capabilities. */
export function signInGovernedAdmin(capabilities: GVCapabilities) {
  useAuthStore.setState({ user: { ...ADMIN }, sessionId: 's', authEpoch: 1 })
  useCapabilitiesStore.setState({ identity: '1:s:1', state: { status: 'ready', capabilities } })
}
