import { useEffect } from 'react'
import { useAuthStore } from '../../../stores/authStore'
import { POLL_INTERVAL_MS, useMerchantWorkbenchStore } from '../../../stores/merchantWorkbench'

// SPEC-MERCHANT-WORKBENCH-001 §3.2. Page lifecycle shared by every mounted
// workbench consumer: one 60 s timer that runs only while the page is visible
// and focused and only refreshes /urgent; focus regain applies per-group 30 s
// gates; a session change clears all facts before the new session loads.

let consumers = 0
let timer: ReturnType<typeof setInterval> | null = null

function pageActive() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function startTimer() {
  if (timer != null) return
  timer = setInterval(() => {
    if (pageActive()) void useMerchantWorkbenchStore.getState().tick()
  }, POLL_INTERVAL_MS)
}

function stopTimer() {
  if (timer == null) return
  clearInterval(timer)
  timer = null
}

function handleFocus() {
  void useMerchantWorkbenchStore.getState().focus()
  if (pageActive()) startTimer()
}

function handleBlur() {
  stopTimer()
}

function handleVisibility() {
  if (document.visibilityState === 'visible') handleFocus()
  else stopTimer()
}

function attach() {
  window.addEventListener('focus', handleFocus)
  window.addEventListener('blur', handleBlur)
  document.addEventListener('visibilitychange', handleVisibility)
  if (pageActive()) startTimer()
}

function detach() {
  window.removeEventListener('focus', handleFocus)
  window.removeEventListener('blur', handleBlur)
  document.removeEventListener('visibilitychange', handleVisibility)
  stopTimer()
}

function useSessionKey(): string | null {
  return useAuthStore(state => (state.user ? `${state.authEpoch}:${state.user.id}:${state.sessionId ?? ''}` : null))
}

/** Mount in any page that shows workbench data; returns the shared store state. */
export function useMerchantWorkbench() {
  const sessionKey = useSessionKey()

  useEffect(() => {
    if (useMerchantWorkbenchStore.getState().sessionKey !== sessionKey) {
      useMerchantWorkbenchStore.getState().reset(sessionKey)
    }
  }, [sessionKey])

  useEffect(() => {
    if (!sessionKey) return
    consumers += 1
    if (consumers === 1) attach()
    void useMerchantWorkbenchStore.getState().enter()
    return () => {
      consumers -= 1
      if (consumers === 0) detach()
    }
  }, [sessionKey])

  return useMerchantWorkbenchStore()
}

/** Test-only: drop module-level lifecycle state between tests. */
export function __resetWorkbenchLifecycleForTests() {
  consumers = 0
  detach()
}
