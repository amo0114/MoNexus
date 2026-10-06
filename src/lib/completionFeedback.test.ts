import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { showCompletionToast, showCompletionActivity } from './completionFeedback'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({ matches: true, media }) as MediaQueryList)
  useAppStore.setState({ islandNotice: null, islandQueue: [], islandNoticeAvailable: true, modalDepth: 1, toasts: [] })
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

it('waits for actual overlay teardown then shows the completion exactly once', () => {
  showCompletionToast('头像已更新')
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts).toEqual([])
  useAppStore.getState().modalClosed()
  expect(useAppStore.getState().islandNotice?.message).toBe('头像已更新')
  useAppStore.getState().clearIslandNotice()
  vi.advanceTimersByTime(1000)
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('keeps feedback visible when a parent dialog remains, without forcing it closed', () => {
  useAppStore.setState({ modalDepth: 2 })
  showCompletionToast('评价已提交')
  useAppStore.getState().modalClosed()
  vi.advanceTimersByTime(700)
  expect(useAppStore.getState().modalDepth).toBe(1)
  expect(useAppStore.getState().toasts[0].message).toBe('评价已提交')
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('drops completion belonging to a session that ended during exit', () => {
  showCompletionToast('头像已更新')
  useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 })
  useAppStore.getState().modalClosed()
  vi.advanceTimersByTime(1000)
  expect(useAppStore.getState().toasts).toEqual([])
  expect(useAppStore.getState().islandNotice).toBeNull()
})


it('keeps actionable completion behind the modal and preserves transaction priority', () => {
  const paymentId = useAppStore.getState().triggerIslandActivity({ kind: 'order_processing', title: '兑换中' })
  const onAction = vi.fn()
  showCompletionActivity({ title: '发货成功', actionLabel: '查看订单', onAction })
  expect(useAppStore.getState().islandNotice?.id).toBe(paymentId)
  expect(useAppStore.getState().islandQueue).toHaveLength(1)
  useAppStore.getState().modalClosed()
  useAppStore.getState().clearIslandNotice(paymentId)
  expect(useAppStore.getState().islandNotice?.title).toBe('发货成功')
  const notice = useAppStore.getState().islandNotice!
  useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 })
  notice.onAction?.()
  expect(onAction).not.toHaveBeenCalled()
})

it('keeps desktop completion as a toast', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  showCompletionActivity({ title: '进度已更新', onAction: vi.fn() })
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts[0].message).toBe('进度已更新')
})
