import { useEffect } from 'react'
import { useAuthStore } from '../../../stores/authStore'
import { useMerchantAgentStore } from '../../../stores/merchantAgent'

export function useAgentSessionKey(): string | null {
  return useAuthStore(state => (state.user ? `${state.authEpoch}:${state.user.id}:${state.sessionId ?? ''}` : null))
}

/** Clears the conversation on account switch/logout and probes availability once per session. */
export function useMerchantAgent() {
  const sessionKey = useAgentSessionKey()
  useEffect(() => {
    const store = useMerchantAgentStore.getState()
    if (store.sessionKey !== sessionKey) store.reset(sessionKey)
    if (sessionKey && useMerchantAgentStore.getState().availability === 'unknown') void store.loadAvailability()
  }, [sessionKey])
  return useMerchantAgentStore()
}
