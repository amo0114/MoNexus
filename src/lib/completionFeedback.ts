import { useAppStore, type ToastType, type IslandActivity } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { readAccessTokenIdentity } from '../auth/sessionContext'

export function captureFeedbackOwner() {
  const owner = useAuthStore.getState()
  const sessionId = readAccessTokenIdentity(owner.accessToken)?.sessionId ?? owner.sessionId
  return () => {
    const current = useAuthStore.getState()
    return owner.authEpoch === current.authEpoch && owner.user?.id === current.user?.id
      && sessionId === (readAccessTokenIdentity(current.accessToken)?.sessionId ?? current.sessionId)
  }
}

/** Actionable completions wait in the existing island queue while dialogs exit.
 * Desktop/public layouts retain the original completion toast. */
export function showCompletionActivity(activity: IslandActivity) {
  const state = useAppStore.getState()
  if (!window.matchMedia('(max-width: 767px)').matches || !state.islandNoticeAvailable) {
    showCompletionToast(activity.message || activity.title, activity.type ?? 'success')
    return
  }
  const isCurrent = captureFeedbackOwner()
  state.triggerIslandActivity({
    ...activity,
    kind: 'notification',
    priority: 'completion',
    type: activity.type ?? 'success',
    onAction: activity.onAction ? () => { if (isCurrent()) activity.onAction?.() } : undefined,
  })
}

/** Call after a successful operation starts closing its dialog. Copy/errors
 * keep immediate feedback. A remaining parent dialog receives a visible toast. */
export function showCompletionToast(message: string, type: ToastType = 'success') {
  const state = useAppStore.getState()
  if (!window.matchMedia('(max-width: 767px)').matches || state.modalDepth === 0) {
    state.showToast(message, type)
    return
  }
  const isCurrent = captureFeedbackOwner()
  let done = false
  let unsubscribe = () => {}
  const finish = () => {
    if (done) return
    done = true
    unsubscribe()
    window.clearTimeout(timer)
    if (!isCurrent()) return
    useAppStore.getState().showToast(message, type)
  }
  // Bounded wait for the actual overlay teardown (including its exit motion).
  // Nested workflows retain their parent and get the normal visible feedback.
  const timer = window.setTimeout(finish, 700)
  unsubscribe = useAppStore.subscribe((next) => { if (next.modalDepth === 0) finish() })
}
