import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './appStore'
import { useAuthStore } from './authStore'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
  useAppStore.setState({ islandNotice: null, islandQueue: [], islandNoticeAvailable: true, modalDepth: 0, toasts: [], islandQueuePausedAt: null, islandQueuePausedMs: 0 })
})

it('a reminder burst cannot evict completions; a full completion queue keeps recent results', () => {
  const store = useAppStore.getState()
  store.triggerIslandActivity({ kind: 'order_processing', title: '支付中' })
  for (let i = 0; i < 4; i++) store.triggerIslandActivity({ kind: 'notification', priority: 'completion', title: String(i), groupKey: String(i) })
  for (let i = 0; i < 10; i++) store.triggerIslandActivity({ kind: 'notification', priority: 'reminder', title: '提醒', groupKey: `reminder-${i}` })
  expect(useAppStore.getState().islandQueue.map(n => n.title)).toEqual(['0', '1', '2', '3'])
  store.triggerIslandActivity({ kind: 'notification', priority: 'completion', title: '4', groupKey: '4' })
  expect(useAppStore.getState().islandQueue.map(n => n.title)).toEqual(['1', '2', '3', '4'])
})

it('excludes hidden time for both existing and newly queued results without reviving expired items', () => {
  const store = useAppStore.getState()
  store.triggerIslandActivity({ kind: 'order_processing', title: '支付中' })
  notify('already-expired')
  vi.advanceTimersByTime(30_001)
  notify('before-pause')
  vi.advanceTimersByTime(20_000)
  store.setIslandQueuePaused(true)
  vi.advanceTimersByTime(60_000)
  notify('during-pause')
  store.setIslandQueuePaused(true) // Repeated obscuration does not restart the clock.
  vi.advanceTimersByTime(60_000)
  store.setIslandQueuePaused(false)
  expect(useAppStore.getState().islandQueue.map(n => n.groupKey)).toEqual(['before-pause', 'during-pause'])
  vi.advanceTimersByTime(10_001)
  store.clearIslandNotice()
  expect(useAppStore.getState().islandNotice?.groupKey).toBe('during-pause')
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const notify = (key: string, title = '订单已发货') => useAppStore.getState().triggerIslandActivity({ kind: 'notification', groupKey: key, title, onAction: vi.fn() })

describe('actionable island scheduling', () => {
  it('coalesces an order, queues other orders and protects both from ordinary feedback', () => {
    notify('a')
    const oldId = useAppStore.getState().islandNotice!.id
    notify('a', '订单已关闭')
    notify('b')
    useAppStore.getState().showToast('已复制')
    useAppStore.getState().clearIslandNotice(oldId)
    expect(useAppStore.getState().islandNotice?.title).toBe('订单已关闭')
    expect(useAppStore.getState().islandQueue).toHaveLength(1)
    useAppStore.getState().clearIslandNotice()
    expect(useAppStore.getState().islandNotice?.groupKey).toBe('b')
  })

  it('gives payment priority and resumes queued updates after scoped dismissal', () => {
    notify('a')
    const paymentId = useAppStore.getState().triggerIslandActivity({ kind: 'order_processing', title: '正在确认支付' })
    notify('b')
    notify('b', '订单已关闭')
    expect(useAppStore.getState().islandNotice?.kind).toBe('order_processing')
    expect(useAppStore.getState().islandQueue.map((n) => n.groupKey)).toEqual(['a', 'b'])
    useAppStore.getState().clearIslandNotice(paymentId)
    expect(useAppStore.getState().islandNotice?.groupKey).toBe('a')
  })

  it('bounds the backlog, expires old updates and discards callbacks on layout/session exit', () => {
    useAppStore.getState().triggerIslandActivity({ kind: 'order_processing', title: '支付中' })
    for (let i = 0; i < 10; i++) notify(String(i))
    expect(useAppStore.getState().islandQueue).toHaveLength(4)
    vi.advanceTimersByTime(30_001)
    useAppStore.getState().clearIslandNotice()
    expect(useAppStore.getState().islandNotice).toBeNull()
    notify('a'); notify('b')
    useAppStore.getState().setIslandNoticeAvailable(false)
    expect(useAppStore.getState().islandQueue).toEqual([])
    expect(useAppStore.getState().islandNotice).toBeNull()
    useAppStore.getState().setIslandNoticeAvailable(true)
    notify('a'); notify('b')
    useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 })
    expect(useAppStore.getState().islandQueue).toEqual([])
    expect(useAppStore.getState().islandNotice).toBeNull()
  })

  it('retains actions while a modal/search obscures them; warnings stay visible', () => {
    notify('a')
    useAppStore.getState().modalOpened()
    useAppStore.getState().demoteIslandNotice()
    useAppStore.getState().triggerIslandActivity({ kind: 'notification', title: '订单争议', type: 'warning' })
    expect(useAppStore.getState().islandNotice?.groupKey).toBe('a')
    expect(useAppStore.getState().toasts[0].type).toBe('warning')
  })
})

it('shows a completion before a passive reminder, resumes it and preserves payment priority', () => {
  const reminder = useAppStore.getState().triggerIslandActivity({kind:'notification',title:'邮箱提醒',priority:'reminder'})
  const completion = useAppStore.getState().triggerIslandActivity({kind:'notification',title:'申请已提交',priority:'completion'})
  expect(useAppStore.getState().islandNotice?.id).toBe(completion)
  expect(useAppStore.getState().islandQueue.map(n=>n.id)).toEqual([reminder])
  useAppStore.getState().clearIslandNotice(completion)
  expect(useAppStore.getState().islandNotice?.id).toBe(reminder)
  const payment = useAppStore.getState().triggerIslandActivity({kind:'order_processing',title:'支付中'})
  useAppStore.getState().triggerIslandActivity({kind:'notification',title:'申请已撤回',priority:'completion'})
  expect(useAppStore.getState().islandNotice?.id).toBe(payment)
  useAppStore.getState().clearIslandNotice(payment)
  expect(useAppStore.getState().islandNotice?.title).toBe('申请已撤回')
})
