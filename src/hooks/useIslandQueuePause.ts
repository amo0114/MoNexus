import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

/** Only time with usable navigation counts toward queued feedback expiry. */
export function useIslandQueuePause(obscured: boolean, enabled = true) {
  useEffect(() => {
    const update = () => useAppStore.getState().setIslandQueuePaused(enabled && (obscured || document.visibilityState !== 'visible'))
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      useAppStore.getState().setIslandQueuePaused(false)
    }
  }, [obscured, enabled])
}
